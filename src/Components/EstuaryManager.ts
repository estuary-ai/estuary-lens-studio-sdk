/**
 * Manager component for the Estuary SDK in Lens Studio.
 * Handles the global connection and routes events to registered characters.
 * 
 * Usage:
 * 1. Add this script to a SceneObject in your Lens
 * 2. Configure the input properties
 * 3. Access via EstuaryManager.instance or import directly
 */

import { EstuaryClient } from '../Core/EstuaryClient';
import { EstuaryConfig, validateConfig } from '../Core/EstuaryConfig';
import { ConnectionState, EventEmitter, CameraCaptureRequest } from '../Core/EstuaryEvents';
import { SessionInfo } from '../Models/SessionInfo';
import { BotResponse } from '../Models/BotResponse';
import { BotVoice } from '../Models/BotVoice';
import { SttResponse } from '../Models/SttResponse';
import { InterruptData } from '../Models/InterruptData';

/**
 * Singleton manager for the Estuary SDK in Lens Studio.
 */
export class EstuaryManager extends EventEmitter<any> {
    // Singleton instance
    private static _instance: EstuaryManager | null = null;

    // Private fields
    private _client: EstuaryClient;
    private _config: EstuaryConfig | null = null;
    private _activeCharacter: IEstuaryCharacterHandler | null = null;
    private _registeredCharacters: Map<string, IEstuaryCharacterHandler> = new Map();
    private _initialized: boolean = false;
    private _debugLogging: boolean = false;

    /**
     * Get the singleton instance of EstuaryManager.
     */
    static get instance(): EstuaryManager {
        if (!EstuaryManager._instance) {
            EstuaryManager._instance = new EstuaryManager();
        }
        return EstuaryManager._instance;
    }

    /**
     * Check if an instance exists without creating one.
     */
    static get hasInstance(): boolean {
        return EstuaryManager._instance !== null;
    }

    private constructor() {
        super();
        this._client = new EstuaryClient();
        this.initialize();
    }

    // ==================== Properties ====================

    /** The Estuary configuration */
    get config(): EstuaryConfig | null {
        return this._config;
    }

    set config(value: EstuaryConfig | null) {
        this._config = value;
        if (value) {
            this._client.debugLogging = value.debugLogging ?? false;
        }
    }

    /** Whether the SDK is connected to the server */
    get isConnected(): boolean {
        return this._client.isConnected;
    }

    /** Current connection state */
    get connectionState(): ConnectionState {
        return this._client.state;
    }

    /** Enable or disable debug logging */
    get debugLogging(): boolean {
        return this._debugLogging;
    }

    set debugLogging(value: boolean) {
        this._debugLogging = value;
        this._client.debugLogging = value;
    }

    // ==================== Public Methods ====================

    /**
     * Connect to Estuary servers using the configured settings.
     */
    connect(): void {
        if (!this._config) {
            this.logError('Cannot connect: Config is not set');
            return;
        }

        if (!this._activeCharacter) {
            this.logError('Cannot connect: No active character. Call registerCharacter first.');
            return;
        }

        const validationError = validateConfig(this._config);
        if (validationError) {
            this.logError(`Cannot connect: ${validationError}`);
            return;
        }

        this._client.connect(
            this._config.serverUrl,
            this._config.apiKey,
            this._activeCharacter.characterId,
            this._activeCharacter.playerId
        );
    }

    /**
     * Disconnect from Estuary servers.
     */
    disconnect(): void {
        this._client.disconnect();
    }

    /**
     * Register a character with the manager.
     * @param character The character handler to register
     */
    registerCharacter(character: IEstuaryCharacterHandler): void {
        if (!character) {
            this.logError('Cannot register null character');
            return;
        }

        const key = this.getCharacterKey(character);
        this._registeredCharacters.set(key, character);

        this.log(`Registered character: ${character.characterId} (player: ${character.playerId})`);

        // If this is the first character, make it active
        if (!this._activeCharacter) {
            this.setActiveCharacter(character);
        }
    }

    /**
     * Unregister a character from the manager.
     * @param character The character handler to unregister
     */
    unregisterCharacter(character: IEstuaryCharacterHandler): void {
        if (!character) return;

        const key = this.getCharacterKey(character);
        this._registeredCharacters.delete(key);

        this.log(`Unregistered character: ${character.characterId}`);

        // If this was the active character, clear it
        if (this._activeCharacter === character) {
            this._activeCharacter = null;
        }
    }

    /**
     * Set the active character for the current connection.
     * This will disconnect and reconnect if already connected.
     * @param character The character to make active
     */
    setActiveCharacter(character: IEstuaryCharacterHandler): void {
        if (!character) {
            this.logError('Cannot set null character as active');
            return;
        }

        const wasConnected = this.isConnected;
        const previousCharacter = this._activeCharacter;

        this._activeCharacter = character;

        this.log(`Active character set to: ${character.characterId}`);

        // Reconnect if needed
        if (wasConnected && previousCharacter !== character) {
            this.reconnectWithNewCharacter();
        }
    }

    /**
     * Send a text message to the current character.
     * @param text The message text
     */
    sendText(text: string): void {
        if (!this._client.isConnected) {
            this.logError('Cannot send text: not connected');
            return;
        }

        this._client.sendText(text);
    }

    /**
     * Stream audio data to the server.
     * @param audioBase64 Base64-encoded audio
     */
    streamAudio(audioBase64: string): void {
        if (!this._client.isConnected) {
            return;
        }

        this._client.streamAudio(audioBase64);
    }

    /**
     * Notify the server that audio playback has completed.
     */
    notifyAudioPlaybackComplete(): void {
        if (!this._client.isConnected) {
            return;
        }

        this._client.notifyAudioPlaybackComplete();
    }

    /**
     * Start voice mode on the server (enables Deepgram STT).
     * Must be called before streaming audio for speech-to-text.
     */
    startVoiceMode(): void {
        if (!this._client.isConnected) {
            this.logError('Cannot start voice mode: not connected');
            return;
        }

        this._client.startVoiceMode();
    }

    /**
     * Stop voice mode on the server (disables Deepgram STT).
     */
    stopVoiceMode(): void {
        if (!this._client.isConnected) {
            return;
        }

        this._client.stopVoiceMode();
    }

    /**
     * Send a camera image to the server for AI analysis.
     * @param imageBase64 Base64-encoded image data
     * @param mimeType MIME type of the image (e.g., 'image/jpeg')
     * @param requestId Optional request ID if responding to a camera_capture_request
     * @param text Optional text context to send with the image
     * @param sampleRate TTS output sample rate (default: 16000 for Spectacles hardware)
     */
    sendCameraImage(imageBase64: string, mimeType: string = 'image/jpeg', requestId?: string, text?: string, sampleRate: number = 16000): void {
        if (!this._client.isConnected) {
            this.logError('Cannot send camera image: not connected');
            return;
        }

        this._client.sendCameraImage(imageBase64, mimeType, requestId, text, sampleRate);
    }

    /**
     * Dispose of the manager and release resources.
     */
    dispose(): void {
        this._client.dispose();
        this._registeredCharacters.clear();
        this._activeCharacter = null;
        this._initialized = false;
        EstuaryManager._instance = null;
    }

    /**
     * Process the client's send queue.
     * Call this periodically (e.g., every frame or every few seconds) to ensure
     * queued messages like ping/pong responses are sent even during silence.
     * This prevents connection timeouts when no audio/text is being sent.
     */
    tick(): void {
        this._client.tick();
    }

    // ==================== Private Methods ====================

    private initialize(): void {
        if (this._initialized) return;
        this._initialized = true;

        // Disable auto-reconnect at the client level — EstuaryCharacter
        // already handles reconnection with smarter logic.  Having both
        // layers reconnect independently causes racing WebSocket connections.
        this._client.autoReconnect = false;

        // Subscribe to client events
        this._client.on('sessionConnected', (sessionInfo: SessionInfo) => this.handleSessionConnected(sessionInfo));
        this._client.on('disconnected', (reason: string) => this.handleDisconnected(reason));
        this._client.on('botResponse', (response: BotResponse) => this.handleBotResponse(response));
        this._client.on('botVoice', (voice: BotVoice) => this.handleBotVoice(voice));
        this._client.on('sttResponse', (response: SttResponse) => this.handleSttResponse(response));
        this._client.on('interrupt', (data: InterruptData) => this.handleInterrupt(data));
        this._client.on('error', (error: string) => this.handleError(error));
        this._client.on('connectionStateChanged', (state: ConnectionState) => this.handleConnectionStateChanged(state));
        this._client.on('cameraCaptureRequest', (request: CameraCaptureRequest) => this.handleCameraCaptureRequest(request));

        this.log('EstuaryManager initialized');
    }

    private reconnectWithNewCharacter(): void {
        this.disconnect();
        // Reconnect will happen automatically via the client's reconnect logic
        // or we connect immediately after a brief moment
        this.connect();
    }

    private getCharacterKey(character: IEstuaryCharacterHandler): string {
        return `${character.characterId}:${character.playerId}`;
    }

    // ==================== Event Handlers ====================

    private handleSessionConnected(sessionInfo: SessionInfo): void {
        this.log(`Session connected: ${JSON.stringify(sessionInfo)}`);
        if (this._activeCharacter) {
            this._activeCharacter.handleSessionConnected(sessionInfo);
        }
    }

    private handleDisconnected(reason: string): void {
        this.log(`Disconnected: ${reason}`);
        if (this._activeCharacter) {
            this._activeCharacter.handleDisconnected(reason);
        }
    }

    private handleBotResponse(response: BotResponse): void {
        this.log(`Bot response received`);
        if (this._activeCharacter) {
            this._activeCharacter.handleBotResponse(response);
        }
    }

    private handleBotVoice(voice: BotVoice): void {
        this.log(`Bot voice received: chunk ${voice.chunkIndex}`);
        if (this._activeCharacter) {
            this._activeCharacter.handleBotVoice(voice);
        }
    }

    private handleSttResponse(response: SttResponse): void {
        this.log(`STT response: "${response.text}"`);
        if (this._activeCharacter) {
            this._activeCharacter.handleSttResponse(response);
        }
    }

    private handleInterrupt(data: InterruptData): void {
        this.log(`Interrupt received`);
        if (this._activeCharacter) {
            this._activeCharacter.handleInterrupt(data);
        }
    }

    private handleError(error: string): void {
        this.logError(`Error: ${error}`);
        this.emit('error', error);
        if (this._activeCharacter) {
            this._activeCharacter.handleError(error);
        }
    }

    private handleConnectionStateChanged(state: ConnectionState): void {
        this.log(`Connection state: ${state}`);
        this.emit('connectionStateChanged', state);
        if (this._activeCharacter) {
            this._activeCharacter.handleConnectionStateChanged(state);
        }
    }

    private handleCameraCaptureRequest(request: CameraCaptureRequest): void {
        this.log(`Camera capture request: ${request.request_id}`);
        this.emit('cameraCaptureRequest', request);
        if (this._activeCharacter) {
            this._activeCharacter.handleCameraCaptureRequest(request);
        }
    }

    // ==================== Logging ====================

    private log(message: string): void {
        if (this._debugLogging) {
            print(`[EstuaryManager] ${message}`);
        }
    }

    private logError(message: string): void {
        print(`[EstuaryManager] ERROR: ${message}`);
    }
}

/**
 * Interface for character handlers that can receive events from EstuaryManager.
 */
export interface IEstuaryCharacterHandler {
    characterId: string;
    playerId: string;
    handleSessionConnected(sessionInfo: SessionInfo): void;
    handleDisconnected(reason: string): void;
    handleBotResponse(response: BotResponse): void;
    handleBotVoice(voice: BotVoice): void;
    handleSttResponse(response: SttResponse): void;
    handleInterrupt(data: InterruptData): void;
    handleError(error: string): void;
    handleConnectionStateChanged(state: ConnectionState): void;
    handleCameraCaptureRequest(request: CameraCaptureRequest): void;
}





