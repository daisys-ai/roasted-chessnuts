// WebSocket connector for Daisys API
// Adapted from https://github.com/daisys-ai/daisys-api-python/tree/main/examples/websocket_client

class WebSocketConnector {
    constructor(getWsUrlFunc, onStatusUpdate = null) {
        this.getWsUrlFunc = getWsUrlFunc;
        this.onStatusUpdate = onStatusUpdate;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.isManuallyDisconnected = false;
        this.messageHandlers = new Map();
    }

    async connect() {
        try {
            this.isManuallyDisconnected = false;
            this._updateStatus('Connecting...');
            
            // Get WebSocket URL from backend
            const wsUrl = await this.getWsUrlFunc();
            if (!wsUrl) {
                throw new Error('Failed to get WebSocket URL');
            }

            this.ws = new WebSocket(wsUrl);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                this.reconnectAttempts = 0;
                this._updateStatus('Connected');
            };

            this.ws.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    // Binary message (audio data)
                    this._handleBinaryMessage(event.data);
                } else {
                    // Text message (JSON)
                    try {
                        const message = JSON.parse(event.data);
                        this._handleTextMessage(message);
                    } catch (e) {
                        console.error('Failed to parse message:', e);
                    }
                }
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this._updateStatus('Error: ' + error);
            };

            this.ws.onclose = (event) => {
                this._updateStatus('Disconnected');
                if (!this.isManuallyDisconnected && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this._attemptReconnect();
                }
            };

        } catch (error) {
            console.error('Connection failed:', error);
            this._updateStatus('Failed to connect: ' + error.message);
            throw error;
        }
    }

    disconnect() {
        this.isManuallyDisconnected = true;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this._updateStatus('Disconnected');
    }

    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            if (typeof message === 'object') {
                this.ws.send(JSON.stringify(message));
            } else {
                this.ws.send(message);
            }
        } else {
            throw new Error('WebSocket is not connected');
        }
    }

    onMessage(requestId, handler) {
        if (!this.messageHandlers.has(requestId)) {
            this.messageHandlers.set(requestId, []);
        }
        this.messageHandlers.get(requestId).push(handler);
    }

    offMessage(requestId, handler = null) {
        if (handler) {
            const handlers = this.messageHandlers.get(requestId);
            if (handlers) {
                const index = handlers.indexOf(handler);
                if (index > -1) {
                    handlers.splice(index, 1);
                }
            }
        } else {
            this.messageHandlers.delete(requestId);
        }
    }

    _handleTextMessage(message) {
        const handlers = this.messageHandlers.get(message.request_id);
        if (handlers) {
            handlers.forEach(handler => handler({ type: 'text', data: message }));
        }
    }

    _handleBinaryMessage(data) {
        // Extract request_id from binary message prefix
        const view = new DataView(data);
        const prefixLength = view.getUint32(0, true);
        const prefix = new TextDecoder().decode(data.slice(4, 4 + prefixLength));
        const prefixData = JSON.parse(prefix);
        
        const audioData = data.slice(4 + prefixLength);
        
        const handlers = this.messageHandlers.get(prefixData.request_id);
        if (handlers) {
            handlers.forEach(handler => handler({ 
                type: 'binary', 
                data: audioData,
                metadata: prefixData 
            }));
        }
    }

    _updateStatus(status) {
        if (this.onStatusUpdate) {
            this.onStatusUpdate(status);
        }
    }

    _attemptReconnect() {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        
        this._updateStatus(`Reconnecting in ${delay / 1000}s...`);
        
        setTimeout(() => {
            this.connect().catch(error => {
                console.error('Reconnection failed:', error);
            });
        }, delay);
    }

    get isConnected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }
}

// Export to window for dynamic loading
window.WebSocketConnector = { WebSocketConnector };