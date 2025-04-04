const {default: axios} = require("axios");
//new for telemetry monitoring
const { trace, context } = require("@opentelemetry/api");
const activeSpan = trace.getSpan(context.active());

class WhatsAppRateLimiter {
    constructor(defaultDelay) {
        this.lastSentTimes = new Map(); // Tracks the last sent time for each phone number
        this.backoffDelays = new Map(); // Tracks the current backoff delay for each phone number
        this.defaultDelay = defaultDelay; // seconds in milliseconds
        this.maxBackoffDelay = 60000; // Maximum backoff delay (e.g., 60 seconds)
    }

    /**
     * Sends a message to a phone number with rate limiting and backoff.
     * @param {string} phoneNumber - The recipient's phone number.
     * @param {string} message - The message to send.
     * @param {function} sendFunction - A function that actually sends the message (e.g., API call).
     */
    async sendMessageDelay(phoneNumber, phoneNumberID, messages, startIndex = 0) {
        const timeoutPerKB = 10; // Adjust as needed
        let currentIndex = startIndex;
        const anonymizedPhoneNumber = phoneNumber.replace(/\d(?=\d{2})/g, '*');
        while (currentIndex < messages.length) {
            const now = Date.now();
            const lastSentTime = this.lastSentTimes.get(phoneNumber) || 0;
            const backoffDelay = this.backoffDelays.get(phoneNumber) || 0;
            // Calculate wait time if within backoff delay
            const waitTime = Math.max(this.defaultDelay, backoffDelay) - (now - lastSentTime);
            if (waitTime > 0) {
                //console.log(`Waiting ${waitTime}ms before sending next message`);
                await this.sleep(waitTime);
            }

            const {data, ignore} = this.createMessageData(messages, phoneNumber,currentIndex);
            if (!ignore) {
                try {
                    // Attempt to send the message
                    await this.makeHttpRequest(phoneNumberID, data);
                    console.log(`Message sent to ${anonymizedPhoneNumber} message type: "${messages[currentIndex].type}"`);
                    this.lastSentTimes.set(phoneNumber, Date.now());
                    this.backoffDelays.delete(phoneNumber); // Reset backoff on success

                    if (messages[currentIndex].type === 'image') {
                        try {
                            const response = await axios.head(messages[currentIndex].value)
                            if (response.headers['content-length']) {
                                const imageSizeKB =
                                    parseInt(response.headers['content-length']) / 1024
                                const timeout = imageSizeKB * timeoutPerKB
                                await new Promise((resolve) => setTimeout(resolve, timeout))
                            }
                        } catch (error) {
                            console.error('Failed to fetch image size:', error)
                            await new Promise((resolve) => setTimeout(resolve, 5000))
                        }
                        // Send error to OpenTelemetry
                        if (activeSpan) {
                            activeSpan.addEvent("Image fetch error", {
                                phoneNumber: anonymizedPhoneNumber,
                                imageUrl: messages[currentIndex].value,
                                errorMessage: error.message
                            });
                        }
                    }
                    //console.log(`Message sent to ${anonymizedPhoneNumber} with message: ${messages[currentIndex].value}`);
                    currentIndex++;
                } catch (error) {
                    if (error.response && error.response.status === 400) {
                        const errorData = error.response.data.error;

                        // Check for specific rate-limiting error code
                        if (errorData && errorData.code === 131056) {
                            console.log(`Rate limit error for ${anonymizedPhoneNumber}: ${errorData.message}`);
                            console.log(`Details: ${errorData.error_data.details}`);

                            // Send error to OpenTelemetry
                            if (activeSpan) {
                                activeSpan.addEvent("Rate limit error", {
                                    phoneNumber: anonymizedPhoneNumber,
                                    errorCode: errorData.code,
                                    message: errorData.message,
                                    details: errorData.error_data.details
                                });
                            }

                            const nextBackoff = this.calculateBackoffDelay(phoneNumber);
                            this.backoffDelays.set(phoneNumber, nextBackoff);
                            console.log(`Retrying message at index ${currentIndex}: ${messages[currentIndex].value}`);
                            await this.sleep(nextBackoff);
                            continue;
                        } else {
                            console.error(`Unhandled HTTP 400 error for ${anonymizedPhoneNumber}: ${errorData?.message || 'Unknown error'}`);
                        }
                        // Log other 400 errors to OpenTelemetry
                        if (activeSpan) {
                            activeSpan.addEvent("Unhandled HTTP 400 error", {
                                phoneNumber: anonymizedPhoneNumber,
                                errorCode: errorData.code || "Unknown",
                                message: errorData?.message || "Unknown error"
                            });
                            throw error;
                        }
                    } else {
                        console.error(`Failed to send message to ${anonymizedPhoneNumber}: ${error.message}`);
                    }
                    // Log all other errors (e.g., network errors, 500s)
                    if (activeSpan) {
                        activeSpan.addEvent("Message send failure", {
                            phoneNumber: anonymizedPhoneNumber,
                            statusCode: error.response?.status || "Unknown",
                            errorMessage: error.message
                        });
                        throw error;
                    }
                }
            } else {
                console.log(`Ignoring message with type: ${messages[currentIndex].type}`);
                currentIndex++;
            }
        }
    }

    async makeHttpRequest(phoneNumberID, data) {
        try {
            const response = await axios({
                method: 'POST',
                    url: `https://graph.facebook.com/${process.env.WHATSAPP_VERSION}/${phoneNumberID}/messages`,
                    data: data,
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                },
              });
      return response.data;
    } catch (error) {
      console.error(`Error in WhatsApp API request: ${error.message}`);

        // OpenTelemetry logging for errors
        if (activeSpan) {
            activeSpan.addEvent("WhatsApp API request failure", {
                statusCode: error.response?.status || "Unknown",
                phoneNumberID: phoneNumberID,
                errorMessage: error.message,
                errorData: JSON.stringify(error.response?.data || {}),
            });
        }
        throw error;
    }
  }

    /**
     * Handles incoming messages with a delay to avoid responding during active delays.
     * @param {string} phoneNumber - The sender's phone number.
     * @param {function} processFunction - A function that processes the incoming message.
     */
    async receiveMessageDelay(phoneNumber) {
        const backoffDelay = this.backoffDelays.get(phoneNumber);

        // Skip processing if an active backoff delay exists
        if (backoffDelay) {
            console.log(`Ignoring incoming message from ********${phoneNumber.slice(-2)} due to active backoff delay`);
            return true;
        }

        return false
        // Log processing of the message
    }

    /**
     * Calculates the next backoff delay using an exponential strategy.
     * @param {string} phoneNumber - The recipient's phone number.
     * @returns {number} The next backoff delay in milliseconds.
     */
    calculateBackoffDelay(phoneNumber) {
        const currentDelay = this.backoffDelays.get(phoneNumber) || 0;
        const nextDelay = Math.min(currentDelay * 4 || this.defaultDelay, this.maxBackoffDelay);
        return nextDelay;
    }

    /**
     * Helper function to sleep for a specified time using setTimeout.
     * @param {number} ms - Time in milliseconds.
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    createMessageData(messages, from, j) {
        let data;
        let ignore = false;

        if (messages[j].type === 'image') {
            data = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: from,
                type: 'image',
                image: {
                    link: messages[j].value,
                },
            };
        } else if (messages[j].type === 'audio') {
            data = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: from,
                type: 'audio',
                audio: {
                    link: messages[j].value,
                },
            };
        } else if (messages[j].type === 'buttons') {
            data = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: from,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: {
                        text: messages[j - 1]?.value || 'Make your choice',
                    },
                    action: {
                        buttons: messages[j].buttons,
                    },
                },
            };
        } else if (messages[j].type === 'text') {
            data = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: from,
                type: 'text',
                text: {
                    preview_url: true,
                    body: messages[j].value,
                },
            };
        } else {
            ignore = true;
        }

        return {data, ignore};
    }
}

module.exports = WhatsAppRateLimiter;
