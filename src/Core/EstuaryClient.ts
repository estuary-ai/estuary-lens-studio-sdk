/**
 * Low-level WebSocket client for communicating with Estuary servers.
 * Implements Socket.IO v4 protocol over Lens Studio's WebSocket API.
 * 
 * This class handles the WebSocket connection and Socket.IO message parsing
 * for Lens Studio which has its own WebSocket implementation.
 */

import { 
    ConnectionState, 
    EventEmitter
} from './EstuaryEvents';
import { 
    EstuaryConfig, 
    mergeWithDefaults, 
    validateConfig 
} from './EstuaryConfig';
import { SessionInfo, parseSessionInfo } from '../Models/SessionInfo';
import { BotResponse, parseBotResponse } from '../Models/BotResponse';
import { BotVoice, parseBotVoice } from '../Models/BotVoice';
import { SttResponse, parseSttResponse } from '../Models/SttResponse';
import { InterruptData, parseInterruptData } from '../Models/InterruptData';

/** Socket.IO namespace for SDK connections */
const SDK_NAMESPACE = '/sdk';

/** Delay between reconnection attempts in ms */
const RECONNECT_DELAY_MS = 2000;

/** Maximum number of reconnection attempts */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Timeout for Engine.IO handshake before triggering reconnect */
const ENGINEIO_HANDSHAKE_TIMEOUT_MS = 5000;

/** Global reference to InternetModule for WebSocket creation */
let _internetModule: any = null;

/**
 * Set the InternetModule to use for WebSocket connections.
 * This MUST be called before connecting on Spectacles.
 * Note: As of Lens Studio 5.9, createWebSocket was moved from RemoteServiceModule to InternetModule.
 * @param module The InternetModule from your scene
 */
export function setInternetModule(module: any): void {
    _internetModule = module;
    print('[EstuaryClient] InternetModule set');
}

/**
 * Get the current InternetModule.
 */
export function getInternetModule(): any {
    return _internetModule;
}

/**
 * @deprecated Use setInternetModule instead. RemoteServiceModule.createWebSocket was moved to InternetModule in Lens Studio 5.9.
 */
export function setRemoteServiceModule(module: any): void {
    print('[EstuaryClient] WARNING: setRemoteServiceModule is deprecated. Use setInternetModule instead.');
    print('[EstuaryClient] As of Lens Studio 5.9, createWebSocket was moved from RemoteServiceModule to InternetModule.');
    // Try to use it anyway in case it's actually an InternetModule
    _internetModule = module;
}

/**
 * @deprecated Use getInternetModule instead.
 */
export function getRemoteServiceModule(): any {
    return _internetModule;
}

/**
 * Authentication data sent to server.
 */
interface AuthenticateData {
    api_key: string;
    character_id: string;
    player_id: string;
    audio_sample_rate?: number;  // TTS playback sample rate (default 48000, use 16000 for Spectacles)
}

/**
 * Preferences that can be updated at any time during the session.
 */
export interface ClientPreferences {
    /** When true, backend will generate a voice acknowledgment before camera capture */
    enableVisionAcknowledgment?: boolean;
}

/**
 * Text message payload.
 */
interface TextPayload {
    text: string;
}

/**
 * Audio message payload.
 */
interface AudioPayload {
    audio: string;
}

/**
 * Camera capture request from server.
 */
interface CameraCaptureRequest {
    request_id: string;
    text?: string;
}

/**
 * Camera image payload to send to server.
 */
interface CameraImagePayload {
    image: string;  // base64 encoded image
    mime_type: string;
    request_id?: string;
    text?: string;
    sample_rate?: number;  // TTS output sample rate (default: 16000 for Spectacles)
}

/**
 * Estuary WebSocket client for Lens Studio.
 * Implements Socket.IO v4 protocol using Lens Studio's WebSocket API.
 */
export class EstuaryClient extends EventEmitter<any> {
    private _config: Required<EstuaryConfig>;
    private _state: ConnectionState = ConnectionState.Disconnected;
    private _currentSession: SessionInfo | null = null;
    private _webSocket: any = null; // Lens Studio WebSocket
    private _reconnectAttempts: number = 0;
    private _disposed: boolean = false;
    private _namespace: string = SDK_NAMESPACE;
    private _auth: AuthenticateData | null = null;
    private _connectStartMs: number | null = null;
    private _wsOpenMs: number | null = null;
    private _firstMessageMs: number | null = null;
    private _engineIoOpenMs: number | null = null;
    private _namespaceConnectedMs: number | null = null;
    private _sessionInfoMs: number | null = null;
    private _handshakeTimeoutStartMs: number | null = null;

    // Send queue to prevent WebSocket message corruption
    // Lens Studio's WebSocket concatenates rapid sends into single packets!
    private _sendQueue: string[] = [];
    private _isSending: boolean = false;
    private _lastSendTime: number = 0;
    private _minSendGapMs: number = 100; // Minimum 100ms gap - Lens Studio WebSocket needs time to flush
    private _maxQueueSize: number = 5; // Drop old audio if queue gets too long

    /**
     * Create a new EstuaryClient.
     * @param config Initial configuration (can be updated before connecting)
     */
    constructor(config?: Partial<EstuaryConfig>) {
        super();
        this._config = mergeWithDefaults(config as EstuaryConfig || {
            serverUrl: '',
            apiKey: '',
            characterId: '',
            playerId: ''
        });
    }

    // ==================== Properties ====================

    /** Current connection state */
    get state(): ConnectionState {
        return this._state;
    }

    /** Whether the client is currently connected */
    get isConnected(): boolean {
        return this._state === ConnectionState.Connected;
    }

    /** Current session information (null if not connected) */
    get currentSession(): SessionInfo | null {
        return this._currentSession;
    }

    /** Enable debug logging */
    get debugLogging(): boolean {
        return this._config.debugLogging;
    }

    set debugLogging(value: boolean) {
        this._config.debugLogging = value;
    }

    // ==================== Public Methods ====================

    /**
     * Connect to an Estuary character.
     * @param serverUrl The Estuary server URL
     * @param apiKey Your Estuary API key
     * @param characterId The character UUID to connect to
     * @param playerId Unique player identifier for conversation persistence
     */
    connect(
        serverUrl: string, 
        apiKey: string, 
        characterId: string, 
        playerId: string
    ): void {
        if (this._disposed) {
            print('[EstuaryClient] ERROR: Client has been disposed');
            return;
        }

        // Update config
        this._config.serverUrl = serverUrl.replace(/\/$/, '');
        this._config.apiKey = apiKey;
        this._config.characterId = characterId;
        this._config.playerId = playerId;

        // Validate config
        const validationError = validateConfig(this._config);
        if (validationError) {
            print('[EstuaryClient] ERROR: ' + validationError);
            return;
        }

        this.connectInternal();
    }

    /**
     * Disconnect from the server.
     */
    disconnect(): void {
        if (this._disposed) return;
        this._handshakeTimeoutStartMs = null;

        if (this._webSocket) {
            try {
                // Send Socket.IO disconnect for namespace
                this.sendRaw('41' + this._namespace);
                this._webSocket.close();
            } catch (e) {
                this.log(`Error during disconnect: ${e}`);
            }
            this._webSocket = null;
        }

        this.setState(ConnectionState.Disconnected);
        this._currentSession = null;
        this._reconnectAttempts = 0;
    }

    /**
     * Send a text message to the character.
     * @param text The message text
     */
    sendText(text: string): void {
        if (!this.isConnected) {
            this.logError('Cannot send text: not connected');
            return;
        }

        const payload: TextPayload = { text };
        this.emitSocketEvent('text', payload);
        this.log(`Sent text: ${text}`);
    }

    /**
     * Stream audio data to the server for speech-to-text.
     * @param audioBase64 Base64-encoded 16-bit PCM audio at 16kHz
     */
    streamAudio(audioBase64: string): void {
        if (!this.isConnected) {
            this.logError('Cannot stream audio: not connected');
            return;
        }

        // Validate and clean the base64 string - remove any non-base64 characters
        // This prevents garbage bytes from corrupting the JSON payload
        let cleanBase64 = audioBase64.replace(/[^A-Za-z0-9+/=]/g, '');
        
        if (cleanBase64.length !== audioBase64.length) {
            this.log(`Cleaned ${audioBase64.length - cleanBase64.length} invalid chars from audio base64`);
        }
        
        if (cleanBase64.length === 0) {
            return;
        }
        
        // Ensure base64 length is multiple of 4 (add padding if needed)
        const remainder = cleanBase64.length % 4;
        if (remainder > 0) {
            cleanBase64 += '='.repeat(4 - remainder);
        }

        const payload: AudioPayload = { audio: cleanBase64 };
        this.emitSocketEvent('stream_audio', payload);
    }

    /**
     * Notify the server that audio playback has completed.
     */
    notifyAudioPlaybackComplete(): void {
        if (!this.isConnected) {
            this.logError('Cannot notify playback complete: not connected');
            return;
        }

        this.emitSocketEvent('audio_playback_complete', null);
        this.log('Notified audio playback complete');
    }

    /**
     * Signal to the server that a camera image is about to be sent.
     * This allows the server to send a vision acknowledgment and wait for the image
     * instead of generating a "I can't see" response.
     * 
     * @param text The transcript that triggered vision detection
     * @param requestId Optional request ID for correlation
     */
    sendVisionPending(text: string, requestId?: string): void {
        if (!this.isConnected) {
            this.logError('Cannot send vision pending: not connected');
            return;
        }

        const payload = {
            text: text,
            request_id: requestId || `vision-pending-${Date.now()}`
        };
        this.emitSocketEvent('vision_pending', payload);
        this.log(`Sent vision_pending signal for: ${text.substring(0, 50)}...`);
    }

    /**
     * Start voice mode on the server (enables Deepgram STT).
     * Must be called before streaming audio for speech-to-text.
     */
    startVoiceMode(): void {
        if (!this.isConnected) {
            this.logError('Cannot start voice mode: not connected');
            return;
        }

        this.emitSocketEvent('start_voice', null);
        this.log('Requested server to start voice mode');
    }

    /**
     * Stop voice mode on the server (disables Deepgram STT).
     * Call this when switching to text-only mode to save STT costs.
     */
    stopVoiceMode(): void {
        if (!this.isConnected) {
            this.logError('Cannot stop voice mode: not connected');
            return;
        }

        this.emitSocketEvent('stop_voice', null);
        this.log('Requested server to stop voice mode');
    }

    /**
     * Update session preferences on the server.
     * Can be called at any time while connected to update settings like vision acknowledgment.
     * @param preferences - The preferences to update
     */
    updatePreferences(preferences: ClientPreferences): void {
        if (!this.isConnected) {
            this.logError('Cannot update preferences: not connected');
            return;
        }

        this.emitSocketEvent('update_preferences', preferences);
        this.log(`Updated preferences: ${JSON.stringify(preferences)}`);
    }

    /**
     * Send a camera image to the server for AI analysis.
     * @param imageBase64 - Base64 encoded image data
     * @param mimeType - MIME type of the image (e.g., 'image/jpeg')
     * @param requestId - Optional request ID if responding to a camera_capture_request
     * @param text - Optional text context to send with the image
     * @param sampleRate - TTS output sample rate (default: 16000 for Spectacles hardware)
     */
    sendCameraImage(imageBase64: string, mimeType: string = 'image/jpeg', requestId?: string, text?: string, sampleRate: number = 16000): void {
        if (!this.isConnected) {
            this.logError('Cannot send camera image: not connected');
            return;
        }

        const payload: CameraImagePayload = {
            image: imageBase64,
            mime_type: mimeType,
            sample_rate: sampleRate,
        };

        if (requestId) {
            payload.request_id = requestId;
        }
        if (text) {
            payload.text = text;
        }

        this.emitSocketEvent('camera_image', payload);
        this.log(`Sent camera image (${mimeType}, ${sampleRate}Hz)${requestId ? ` for request ${requestId}` : ''}`);
    }

    /**
     * Dispose of the client and release resources.
     */
    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        if (this._webSocket) {
            try {
                this._webSocket.close();
            } catch (e) {
                // Ignore errors during cleanup
            }
            this._webSocket = null;
        }

        this._currentSession = null;
        this.removeAllListeners();
    }

    /**
     * Process the send queue.
     * Call this periodically (e.g., from an update loop) to ensure queued messages
     * like ping/pong responses are sent even when no new messages are being added.
     * This prevents connection timeouts during periods of silence.
     */
    tick(): void {
        // Check Engine.IO handshake timeout
        if (this._handshakeTimeoutStartMs !== null) {
            const elapsed = Date.now() - this._handshakeTimeoutStartMs;
            if (elapsed >= ENGINEIO_HANDSHAKE_TIMEOUT_MS) {
                this._handshakeTimeoutStartMs = null;
                this.logError(`Engine.IO handshake timed out after ${elapsed}ms - reconnecting`);
                if (this._webSocket) {
                    try { this._webSocket.close(); } catch (e) { /* ignore */ }
                    this._webSocket = null;
                }
                this.handleReconnect();
                return;
            }
        }
        this.processSendQueue();
    }

    // ==================== Private Methods ====================

    private resetConnectionTimings(): void {
        const now = Date.now();
        this._connectStartMs = now;
        this._wsOpenMs = null;
        this._firstMessageMs = null;
        this._engineIoOpenMs = null;
        this._namespaceConnectedMs = null;
        this._sessionInfoMs = null;
        this.log(`Timing connect_start: 0ms`);
    }

    private logTiming(label: string, timestampMs: number): void {
        if (!this._config.debugLogging) {
            return;
        }
        const parts: string[] = [];
        if (this._connectStartMs !== null) {
            parts.push(`since connect=${timestampMs - this._connectStartMs}ms`);
        }
        if (this._wsOpenMs !== null) {
            parts.push(`since ws open=${timestampMs - this._wsOpenMs}ms`);
        }
        if (this._firstMessageMs !== null) {
            parts.push(`since first msg=${timestampMs - this._firstMessageMs}ms`);
        }
        this.log(`Timing ${label}: ${parts.join(', ')}`);
    }

    private connectInternal(): void {
        this.setState(ConnectionState.Connecting);
        this.resetConnectionTimings();

        try {
            // Build WebSocket URL
            const wsUrl = this.buildWebSocketUrl();
            
            // Store auth for namespace connection
            // Include audio_sample_rate to tell server what TTS sample rate to use
            this._auth = {
                api_key: this._config.apiKey,
                character_id: this._config.characterId,
                player_id: this._config.playerId,
                audio_sample_rate: this._config.playbackSampleRate || 16000  // Default 16kHz for Spectacles
            };

            this.log(`Connecting to ${wsUrl}...`);
            this.log(`Authenticating with player_id: ${this._config.playerId}`);

            // Create WebSocket connection using Lens Studio's InternetModule
            // Note: As of Lens Studio 5.9, createWebSocket was moved from RemoteServiceModule to InternetModule
            let ws: any = null;
            
            // Try to create WebSocket using InternetModule
            if (_internetModule) {
                if (typeof _internetModule.createWebSocket === 'function') {
                    this.log('Using InternetModule.createWebSocket()');
                    ws = _internetModule.createWebSocket(wsUrl);
                }
            }
            
            if (!ws) {
                throw new Error('WebSocket creation failed. Make sure InternetModule is connected. (Use setInternetModule() before connecting)');
            }

            this._webSocket = ws;

            // Set up Lens Studio WebSocket event handlers
            this.log('Setting up WebSocket event handlers...');
            
            // Lens Studio InternetModule WebSocket uses standard Web API naming (lowercase):
            // onopen, onclose, onerror, onmessage
            // These are assigned as callbacks, not addEventListener
            ws.onopen = (event: any) => {
                this.log('WebSocket onopen fired');
                this.handleWebSocketOpen();
            };
            ws.onclose = (event: any) => {
                // Log detailed close information
                const code = event?.code || event?.closeCode || 'unknown';
                const reason = event?.reason || event?.closeReason || 'no reason provided';
                const wasClean = event?.wasClean !== undefined ? event.wasClean : 'unknown';
                this.log(`WebSocket onclose fired - Code: ${code}, Reason: ${reason}, Clean: ${wasClean}`);
                
                // Log what close codes mean
                const codeExplanation = this.getCloseCodeExplanation(code);
                if (codeExplanation) {
                    this.log(`Close code ${code} means: ${codeExplanation}`);
                }
                
                this.handleWebSocketClose();
            };
            ws.onerror = (event: any) => {
                // Try to extract error details
                const errorMsg = event?.message || event?.error || event?.type || 'unknown error';
                this.log(`WebSocket onerror fired - Details: ${errorMsg}`);
                
                // Log all properties of the error event for debugging
                if (this._config.debugLogging) {
                    const props: string[] = [];
                    for (const key in event) {
                        try {
                            const val = event[key];
                            if (typeof val !== 'function') {
                                props.push(`${key}=${val}`);
                            }
                        } catch (e) {}
                    }
                    if (props.length > 0) {
                        this.log(`Error event properties: ${props.join(', ')}`);
                    }
                }
                
                this.handleWebSocketError('WebSocket error');
            };
            ws.onmessage = (event: any) => {
                // Lens Studio WebSocketMessageEvent has 'data' property
                const message = typeof event === 'string' ? event : (event?.data || '');
                this.handleWebSocketMessage(message);
            };
            
            this.log('WebSocket event handlers assigned, connection should auto-open...');

        } catch (e: any) {
            const errorMsg = String(e);
            
            // Check if this is the simulator limitation error
            if (errorMsg.includes('not available on the simulated platform')) {
                this.logError('=======================================================');
                this.logError('WebSocket NOT available in Lens Studio Preview!');
                this.logError('This only works on actual Spectacles hardware.');
                this.logError('Deploy your Lens to test WebSocket features.');
                this.logError('=======================================================');
                
                // Don't retry - this will never work in simulator
                this._reconnectAttempts = this._config.maxReconnectAttempts;
                this.setState(ConnectionState.Error);
                this.emit('error', 'WebSocket not available in Preview. Deploy to Spectacles to test.');
                return;
            }
            
            this.logError(`Connection failed: ${e}`);
            this.setState(ConnectionState.Error);
            this.emit('error', String(e));
            this.handleReconnect();
        }
    }

    private buildWebSocketUrl(): string {
        // Convert HTTP(S) to WS(S)
        let wsUrl = this._config.serverUrl
            .replace('https://', 'wss://')
            .replace('http://', 'ws://');

        // Add Socket.IO path and query params
        // EIO=4 for Engine.IO v4 (Socket.IO v4)
        return `${wsUrl}/socket.io/?EIO=4&transport=websocket`;
    }

    private handleWebSocketOpen(): void {
        const now = Date.now();
        this._wsOpenMs = now;
        this.logTiming('ws_open', now);
        this.log('WebSocket connected, waiting for Engine.IO handshake...');
        this._reconnectAttempts = 0;
        this._handshakeTimeoutStartMs = now;
    }

    private handleWebSocketClose(): void {
        this.log('WebSocket closed');
        this._handshakeTimeoutStartMs = null;

        this.setState(ConnectionState.Disconnected);
        this._currentSession = null;
        this.emit('disconnected', 'connection closed');

        // Attempt reconnect
        if (this._config.autoReconnect) {
            this.handleReconnect();
        }
    }

    private handleWebSocketError(error: string): void {
        this.logError('WebSocket error: ' + error);
        this.emit('error', 'WebSocket connection error: ' + error);
    }

    private handleWebSocketMessage(message: string): void {
        if (this._firstMessageMs === null) {
            const now = Date.now();
            this._firstMessageMs = now;
            this.logTiming('first_message', now);
        }
        this.processSocketIOMessage(message);
    }

    /**
     * Process Socket.IO protocol message.
     * 
     * Socket.IO v4 message format:
     * - 0 - Engine.IO open (connection established)
     * - 2 - Engine.IO ping
     * - 3 - Engine.IO pong
     * - 4 - Socket.IO message prefix
     * - 40 - Socket.IO connect to namespace
     * - 41 - Socket.IO disconnect from namespace
     * - 42 - Socket.IO event
     * - 44 - Socket.IO connect error
     */
    private processSocketIOMessage(message: string): void {
        this.log(`Received: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);

        if (message.startsWith('0')) {
            // Engine.IO open - now connect to namespace WITHOUT auth (deferred)
            this._handshakeTimeoutStartMs = null;
            if (this._engineIoOpenMs === null) {
                const now = Date.now();
                this._engineIoOpenMs = now;
                this.logTiming('engineio_open', now);
            }
            this.log('Engine.IO connected, joining namespace (deferred auth)...');
            // Send namespace connect without auth — server accepts immediately,
            // then we send auth as a separate event to avoid blocking the handshake.
            const connectMsg = '40' + this._namespace;
            this.sendRaw(connectMsg);
        }
        else if (message.startsWith('2')) {
            // Engine.IO ping - respond with pong
            this.sendRaw('3');
        }
        else if (message.startsWith('40' + this._namespace) || message.startsWith('40,')) {
            // Socket.IO namespace connected
            if (this._namespaceConnectedMs === null) {
                const now = Date.now();
                this._namespaceConnectedMs = now;
                this.logTiming('namespace_connected', now);
            }
            this.log('Namespace connected, sending deferred authenticate...');
            // Send auth as a separate event — the server's on_sdk_authenticate handler
            // processes this and sends session_info back.
            this.emitSocketEvent('authenticate', this._auth);
        }
        else if (message.startsWith('44')) {
            // Socket.IO connect error
            const errorStart = message.indexOf('{');
            const errorJson = errorStart >= 0 ? message.substring(errorStart) : '{}';
            try {
                const error = JSON.parse(errorJson);
                const errorMsg = error.message || error.error || 'Connection refused';
                this.logError(`Connection error: ${errorMsg}`);
                this.setState(ConnectionState.Error);
                this.emit('error', errorMsg);
            } catch {
                this.logError(`Connection error: ${message}`);
                this.emit('error', 'Connection refused');
            }
        }
        else if (message.startsWith('42')) {
            // Socket.IO event
            this.parseAndDispatchEvent(message);
        }
    }

    private parseAndDispatchEvent(message: string): void {
        try {
            // Remove Socket.IO prefix (42 or 42/namespace)
            const jsonStart = message.indexOf('[');
            if (jsonStart < 0) return;

            const json = message.substring(jsonStart);
            
            // Parse as array: ["eventName", data]
            const parsed = JSON.parse(json);
            if (!Array.isArray(parsed) || parsed.length < 1) return;

            const eventName = parsed[0];
            const eventData = parsed.length > 1 ? parsed[1] : null;

            this.log(`Event: ${eventName}`);
            this.handleServerEvent(eventName, eventData);

        } catch (e) {
            this.logError(`Failed to parse Socket.IO event: ${e}`);
        }
    }

    private handleServerEvent(eventName: string, data: any): void {
        switch (eventName) {
            case 'session_info':
                this.handleSessionInfo(data);
                break;
            case 'bot_response':
                this.handleBotResponse(data);
                break;
            case 'bot_voice':
                this.handleBotVoice(data);
                break;
            case 'stt_response':
                this.handleSttResponse(data);
                break;
            case 'interrupt':
                this.handleInterrupt(data);
                break;
            case 'auth_error':
                this.handleAuthError(data);
                break;
            case 'error':
                this.handleServerError(data);
                break;
            case 'quota_exceeded':
                this.handleQuotaExceeded(data);
                break;
            case 'camera_capture':
                this.handleCameraCaptureRequest(data);
                break;
            default:
                this.log(`Unhandled event: ${eventName}`);
        }
    }

    private handleSessionInfo(data: any): void {
        try {
            if (this._sessionInfoMs === null) {
                const now = Date.now();
                this._sessionInfoMs = now;
                this.logTiming('session_info', now);
            }
            const sessionInfo = parseSessionInfo(data);
            this._currentSession = sessionInfo;
            this.setState(ConnectionState.Connected);
            this.log(`Session established: ${JSON.stringify(sessionInfo)}`);
            this.emit('sessionConnected', sessionInfo);
        } catch (e) {
            this.logError(`Failed to parse session_info: ${e}`);
        }
    }

    private handleBotResponse(data: any): void {
        try {
            const response = parseBotResponse(data);
            this.log(`Bot response: ${response.text.substring(0, 50)}...`);
            this.emit('botResponse', response);
        } catch (e) {
            this.logError(`Failed to parse bot_response: ${e}`);
        }
    }

    private handleBotVoice(data: any): void {
        if (!data) {
            this.log('Received empty bot_voice event, ignoring');
            return;
        }

        try {
            const voice = parseBotVoice(data);
            this.log(`Bot voice: chunk ${voice.chunkIndex}, ${voice.audio.length} chars`);
            this.emit('botVoice', voice);
        } catch (e) {
            this.logError(`Failed to parse bot_voice: ${e}`);
        }
    }

    private handleSttResponse(data: any): void {
        try {
            const response = parseSttResponse(data);
            this.log(`STT response: "${response.text}" (final: ${response.isFinal})`);
            this.emit('sttResponse', response);
        } catch (e) {
            this.logError(`Failed to parse stt_response: ${e}`);
        }
    }

    private handleInterrupt(data: any): void {
        try {
            const interruptData = parseInterruptData(data);
            this.log(`Interrupt: ${JSON.stringify(interruptData)}`);
            this.emit('interrupt', interruptData);
        } catch (e) {
            this.logError(`Failed to parse interrupt: ${e}`);
        }
    }

    private handleAuthError(data: any): void {
        const errorMsg = data?.error || data?.message || 'Authentication failed';
        this.logError(`Authentication error: ${errorMsg}`);
        this.setState(ConnectionState.Error);
        this.emit('error', `Authentication error: ${errorMsg}`);
    }

    private handleServerError(data: any): void {
        const errorMsg = data?.message || data?.error || 'Server error';
        this.logError(`Server error: ${errorMsg}`);
        this.emit('error', errorMsg);
    }

    private handleQuotaExceeded(data: any): void {
        const message = data?.message || 'API quota exceeded';
        this.logError(`Quota exceeded: ${message}`);
    }

    private handleCameraCaptureRequest(data: any): void {
        try {
            const requestId = data?.request_id || '';
            const text = data?.text;
            print('');
            print('📷 ========================================');
            print('📷 CAMERA CAPTURE REQUEST FROM SERVER');
            print(`📷 Request ID: ${requestId}`);
            print(`📷 Context: ${text || '(none)'}`);
            print('📷 ========================================');
            print('');
            this.emit('cameraCaptureRequest', { request_id: requestId, text });
        } catch (e) {
            this.logError(`Failed to handle camera_capture_request: ${e}`);
        }
    }

    private handleReconnect(): void {
        if (this._disposed || !this._config.autoReconnect) {
            return;
        }

        if (this._reconnectAttempts >= this._config.maxReconnectAttempts) {
            this.logError(`Max reconnect attempts (${this._config.maxReconnectAttempts}) reached`);
            this.setState(ConnectionState.Error);
            return;
        }

        this._reconnectAttempts++;
        this.setState(ConnectionState.Reconnecting);
        
        this.log(`Reconnecting... attempt ${this._reconnectAttempts}/${this._config.maxReconnectAttempts}`);

        // Reconnect immediately - for delayed reconnect, use Lens Studio's 
        // DelayedCallbackEvent in your own script
        this.connectInternal();
    }

    private setState(newState: ConnectionState): void {
        if (this._state !== newState) {
            this._state = newState;
            this.emit('connectionStateChanged', newState);
        }
    }

    /**
     * Emit a Socket.IO event to the server.
     */
    private emitSocketEvent(eventName: string, data: any): void {
        // Ensure data is JSON-safe by re-parsing (catches any weird characters)
        let payload: string;
        if (data !== null) {
            const jsonArray = [eventName, data];
            payload = JSON.stringify(jsonArray);
            // Double-check the JSON is valid by parsing it back
            try {
                JSON.parse(payload);
            } catch (e) {
                this.logError(`Invalid JSON payload for event ${eventName}: ${e}`);
                return;
            }
        } else {
            payload = JSON.stringify([eventName]);
        }
        // Use string concatenation instead of template literals for reliability
        const message = '42' + this._namespace + ',' + payload;
        this.sendRaw(message);
    }

    /**
     * Send raw message to WebSocket.
     * Uses a queue to prevent simultaneous sends which can cause corruption.
     */
    private sendRaw(message: string): void {
        if (!this._webSocket) {
            return;
        }
        
        // Clean the message aggressively to prevent garbage bytes
        // 1. Remove control characters
        let cleanMessage = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        
        // 2. For JSON-containing messages, ensure they end correctly
        // Socket.IO messages end with } or ] for the JSON payload
        if (cleanMessage.includes('{') || cleanMessage.includes('[')) {
            // Find the last valid JSON terminator
            const lastBrace = cleanMessage.lastIndexOf('}');
            const lastBracket = cleanMessage.lastIndexOf(']');
            const lastValid = Math.max(lastBrace, lastBracket);
            
            if (lastValid > 0 && lastValid < cleanMessage.length - 1) {
                // There's garbage after the JSON - truncate it
                const garbage = cleanMessage.substring(lastValid + 1);
                this.log('Removing trailing garbage: "' + garbage + '" (' + garbage.length + ' chars)');
                cleanMessage = cleanMessage.substring(0, lastValid + 1);
            }
        }
        
        // Add to queue, but manage overflow for audio messages
        if (this._sendQueue.length >= this._maxQueueSize) {
            // Queue is full - drop oldest audio messages to make room
            // Keep non-audio messages (they're important for protocol)
            const isAudioMessage = cleanMessage.includes('stream_audio');
            if (isAudioMessage) {
                // Find and remove oldest audio message
                for (let i = 0; i < this._sendQueue.length; i++) {
                    if (this._sendQueue[i].includes('stream_audio')) {
                        this._sendQueue.splice(i, 1);
                        break;
                    }
                }
            }
        }
        
        this._sendQueue.push(cleanMessage);
        
        // Process queue if not already processing
        this.processSendQueue();
    }
    
    /**
     * Process the send queue - sends ONE message only.
     * CRITICAL: Do NOT recurse or send multiple messages per call!
     * Lens Studio's WebSocket concatenates rapid sends into single TCP packets,
     * which corrupts the Socket.IO protocol.
     */
    private processSendQueue(): void {
        if (this._isSending || this._sendQueue.length === 0 || !this._webSocket) {
            return;
        }
        
        // STRICT gap enforcement - Lens Studio WebSocket needs time to flush
        const now = Date.now();
        const timeSinceLastSend = now - this._lastSendTime;
        if (timeSinceLastSend < this._minSendGapMs) {
            // Not enough time passed - wait for next frame
            // Do NOT recurse, do NOT process more messages
            return;
        }
        
        this._isSending = true;
        const message = this._sendQueue.shift()!;
        
        // Only log non-audio messages or every 10th audio to reduce log spam
        const isAudio = message.includes('stream_audio');
        if (!isAudio) {
            this.log('Sending (' + message.length + ' chars): ' + message.substring(0, 100) + (message.length > 100 ? '...' : ''));
        }
        
        try {
            this._webSocket.send(message);
            this._lastSendTime = now;
        } catch (e) {
            this.logError('Failed to send message: ' + e);
        }
        
        this._isSending = false;
        
        // Do NOT process next message here!
        // Wait for next frame/call to avoid Lens Studio WebSocket concatenation bug
    }

    /**
     * Get human-readable explanation for WebSocket close codes
     */
    private getCloseCodeExplanation(code: number | string): string {
        const codeNum = typeof code === 'string' ? parseInt(code, 10) : code;
        switch (codeNum) {
            case 1000: return 'Normal closure - connection completed successfully';
            case 1001: return 'Going away - server shutting down or browser navigating away';
            case 1002: return 'Protocol error - endpoint received malformed frame';
            case 1003: return 'Unsupported data - received data type not supported';
            case 1005: return 'No status received - no close code was provided';
            case 1006: return 'Abnormal closure - connection dropped without close frame (network issue, server crash, or TLS failure)';
            case 1007: return 'Invalid frame payload data - message contained inconsistent data';
            case 1008: return 'Policy violation - message violates policy';
            case 1009: return 'Message too big - message exceeded size limit';
            case 1010: return 'Missing extension - client expected server to negotiate extension';
            case 1011: return 'Internal error - server encountered unexpected condition';
            case 1012: return 'Service restart - server is restarting';
            case 1013: return 'Try again later - server is temporarily unavailable';
            case 1014: return 'Bad gateway - server acting as gateway received invalid response';
            case 1015: return 'TLS handshake failed - TLS/SSL certificate error';
            default: return '';
        }
    }

    private log(message: string): void {
        if (this._config.debugLogging) {
            print(`[EstuaryClient] ${message}`);
        }
    }

    private logError(message: string): void {
        print(`[EstuaryClient] ERROR: ${message}`);
    }
}





