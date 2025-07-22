// WebSocket stream handler for Daisys API
// Adapted from https://github.com/daisys-ai/daisys-api-python/tree/main/examples/websocket_client

class WebSocketStream {
    constructor(connector) {
        this.connector = connector;
        this.activeStreams = new Map();
    }

    async *streamRequest(requestId, requestData) {
        const messageBuffer = [];
        let isComplete = false;
        let resolver = null;

        // Set up message handler
        const messageHandler = (message) => {
            if (message.type === 'text') {
                if (message.data.type === 'done') {
                    isComplete = true;
                } else {
                    messageBuffer.push(message);
                }
            } else if (message.type === 'binary') {
                messageBuffer.push(message);
            }

            if (resolver) {
                resolver();
                resolver = null;
            }
        };

        this.connector.onMessage(requestId, messageHandler);
        this.activeStreams.set(requestId, { messageBuffer, isComplete });

        try {
            // Send the request
            this.connector.send(requestData);

            // Stream responses
            while (!isComplete || messageBuffer.length > 0) {
                if (messageBuffer.length > 0) {
                    yield messageBuffer.shift();
                } else {
                    // Wait for new messages
                    await new Promise(resolve => {
                        resolver = resolve;
                        // Check again in case a message arrived while setting up the promise
                        if (messageBuffer.length > 0 || isComplete) {
                            resolve();
                        }
                    });
                }
            }
        } finally {
            // Clean up
            this.connector.offMessage(requestId, messageHandler);
            this.activeStreams.delete(requestId);
        }
    }

    cancelStream(requestId) {
        const stream = this.activeStreams.get(requestId);
        if (stream) {
            stream.isComplete = true;
            this.activeStreams.delete(requestId);
        }
    }
}

// Audio utilities for handling WAV data
class AudioUtils {
    static parseWavHeader(buffer) {
        const view = new DataView(buffer);
        
        // Check WAV header
        const riff = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
        if (riff !== 'RIFF') {
            throw new Error('Invalid WAV file');
        }

        // Find format chunk
        let pos = 12;
        while (pos < buffer.byteLength - 8) {
            const chunkId = String.fromCharCode(...new Uint8Array(buffer, pos, 4));
            const chunkSize = view.getUint32(pos + 4, true);
            
            if (chunkId === 'fmt ') {
                const audioFormat = view.getUint16(pos + 8, true);
                const numChannels = view.getUint16(pos + 10, true);
                const sampleRate = view.getUint32(pos + 12, true);
                const bitsPerSample = view.getUint16(pos + 22, true);
                
                return {
                    audioFormat,
                    numChannels,
                    sampleRate,
                    bitsPerSample,
                    dataOffset: pos + 8 + chunkSize
                };
            }
            
            pos += 8 + chunkSize;
        }
        
        throw new Error('Format chunk not found');
    }

    static async decodeAudioData(audioContext, buffer, metadata = null) {
        if (metadata && metadata.chunk_index === 0) {
            // First chunk contains WAV header
            const wavInfo = this.parseWavHeader(buffer);
            const dataStart = buffer.byteLength > 44 ? 44 : 0; // Standard WAV header is 44 bytes
            const audioData = buffer.slice(dataStart);
            
            return {
                wavInfo,
                audioData: this.convertPCMToFloat32(audioData, wavInfo.bitsPerSample)
            };
        } else {
            // Subsequent chunks are raw PCM data
            const bitsPerSample = metadata?.bits_per_sample || 16;
            return {
                audioData: this.convertPCMToFloat32(buffer, bitsPerSample)
            };
        }
    }

    static convertPCMToFloat32(buffer, bitsPerSample) {
        const bytesPerSample = bitsPerSample / 8;
        const numSamples = buffer.byteLength / bytesPerSample;
        const float32Array = new Float32Array(numSamples);
        const view = new DataView(buffer);
        
        for (let i = 0; i < numSamples; i++) {
            if (bitsPerSample === 16) {
                const sample = view.getInt16(i * 2, true);
                float32Array[i] = sample / 32768.0;
            } else if (bitsPerSample === 32) {
                float32Array[i] = view.getFloat32(i * 4, true);
            }
        }
        
        return float32Array;
    }
}

// Export to window for dynamic loading
window.WebSocketStream = { WebSocketStream, AudioUtils };