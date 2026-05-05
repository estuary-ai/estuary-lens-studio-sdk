/**
 * Manager component for the Estuary SDK in Lens Studio.
 * Handles the global connection and routes events to registered characters.
 * 
 * Usage:
 * 1. Add this script to a SceneObject in your Lens
 * 2. Configure the input properties
 * 3. Access via EstuaryManager.instance or import directly
 */

import { EstuaryClient, setInternetModule, getInternetModule } from '../Core/EstuaryClient';
import { EstuaryHttpClient } from '../Core/EstuaryHttpClient';
import { EstuaryConfig, validateConfig } from '../Core/EstuaryConfig';
import {
    ConnectionState,
    EventEmitter,
    CameraCaptureRequest,
    EncounterMessageHandler,
    EncounterVoiceHandler,
    EncounterEndHandler,
} from '../Core/EstuaryEvents';
import { SessionInfo } from '../Models/SessionInfo';
import { BotResponse } from '../Models/BotResponse';
import { BotVoice } from '../Models/BotVoice';
import { SttResponse } from '../Models/SttResponse';
import { InterruptData } from '../Models/InterruptData';
import { EncounterMessage } from '../Models/EncounterMessage';
import { EncounterVoice } from '../Models/EncounterVoice';
import { EncounterEnd } from '../Models/EncounterEnd';

/**
 * Singleton manager for the Estuary SDK in Lens Studio.
 */
export class EstuaryManager extends EventEmitter<any> {
    // Singleton instance
    private static _instance: EstuaryManager | null = null;

    // Private fields
    private _client: EstuaryClient;
    private _httpClient: EstuaryHttpClient | null = null;
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
            // Mint a fresh HTTP client whenever the config is replaced so
            // serverUrl / apiKey / playerId stay in sync. Used by the
            // Encounter REST helpers (and any future REST methods).
            this._httpClient = new EstuaryHttpClient(value);
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

    /**
     * Set the InternetModule for WebSocket and HTTP connections.
     * Must be called before connect() on Spectacles (Lens Studio 5.9+).
     */
    set internetModule(module: any) {
        setInternetModule(module);
        this.log('InternetModule configured via EstuaryManager');
    }

    get internetModule(): any {
        return getInternetModule();
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

        if (!getInternetModule()) {
            this.logError('Cannot connect: InternetModule is not set. Set EstuaryManager.instance.internetModule before connecting.');
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
     * Script the character to say a specific prewritten line.
     * @param text The scripted line text
     * @param textOnly If true, text-only response (no TTS audio). Default false.
     */
    sayLine(text: string, textOnly: boolean = false): void {
        if (!this._client.isConnected) {
            this.logError('Cannot say line: not connected');
            return;
        }
        this._client.sayLine(text, textOnly);
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
     * Send a client-initiated interrupt to cancel the in-progress bot response.
     * The server will stop generation and emit an `interrupt` event back.
     * @param messageId Optional message ID to interrupt. Omit to interrupt the current response.
     */
    sendClientInterrupt(messageId?: string): void {
        if (!this._client.isConnected) {
            return;
        }

        this._client.sendClientInterrupt(messageId);
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

    // ==================== Encounter (NEW CONVENTION) ====================
    //
    // NEW: Direct EventEmitter forwarders for Encounter (a 2-character
    // feature, not per-character dispatched).
    //
    // Prior features (text_chat, voice_websocket, vision_camera, etc.) wire
    // inbound events internally and dispatch them through
    // ``IEstuaryCharacterHandler`` to the active per-character instance
    // (see ``initialize()`` lines below — ``handleBotResponse`` /
    // ``handleBotVoice`` etc.). That model fits per-character conversation
    // events, but Encounter is a 2-character feature with no single "active
    // character" to dispatch to.
    //
    // Therefore Encounter introduces a NEW convention on EstuaryManager:
    // public ``onEncounterX(handler)`` forwarder methods that subscribe
    // a user-supplied handler directly to the underlying EstuaryClient
    // ``EventEmitter``. This is the FIRST feature to expose EventEmitter
    // subscriptions through EstuaryManager. Document accordingly in
    // CLAUDE.md Parity Status so future readers understand the divergence.

    /**
     * Start a stateless 2-character Encounter.
     *
     * REST POST /api/encounters. Returns ``{encounterId}`` once the server
     * has launched the background task. The caller must then invoke
     * ``subscribeEncounter(encounterId)`` to receive the streamed turns.
     */
    startEncounter(req: {
        characterAId: string;
        characterBId: string;
        prompt: string;
        maxTurns?: number;
        voice?: boolean;
        starter?: 'a' | 'b';
    }): Promise<{ encounterId: string }> {
        if (!this._httpClient) {
            return Promise.reject(new Error(
                'startEncounter: EstuaryManager.config not set — cannot mint HTTP client'
            ));
        }
        return this._httpClient.startEncounter(req);
    }

    /**
     * Subscribe the underlying /sdk Socket.IO session to the encounter's
     * room so that ``encounter_message`` / ``encounter_voice`` /
     * ``encounter_end`` events flow through. Must be called after
     * ``startEncounter()`` returns.
     */
    subscribeEncounter(encounterId: string): void {
        this._client.subscribeEncounter(encounterId);
    }

    /** Subscribe to ``encounter_message`` events. Direct EventEmitter forwarder. */
    onEncounterMessage(handler: EncounterMessageHandler): void {
        this._client.on('encounterMessage', handler);
    }

    /** Subscribe to ``encounter_voice`` events. Direct EventEmitter forwarder. */
    onEncounterVoice(handler: EncounterVoiceHandler): void {
        this._client.on('encounterVoice', handler);
    }

    /** Subscribe to ``encounter_end`` events. Direct EventEmitter forwarder. */
    onEncounterEnd(handler: EncounterEndHandler): void {
        this._client.on('encounterEnd', handler);
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





