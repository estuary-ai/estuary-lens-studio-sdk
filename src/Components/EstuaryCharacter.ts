/**
 * Character component for Estuary AI integration in Lens Studio.
 * Represents an AI character that can engage in voice and text conversations.
 * 
 * Usage:
 * 1. Create an instance of EstuaryCharacter
 * 2. Set characterId and playerId
 * 3. Subscribe to events (botResponse, voiceReceived, transcript, etc.)
 * 4. Call initialize() with config to connect
 * 5. Handle voice playback externally via 'voiceReceived' event
 */

import { EstuaryManager, IEstuaryCharacterHandler } from './EstuaryManager';
import { EstuaryConfig } from '../Core/EstuaryConfig';
import { ConnectionState, EventEmitter, CameraCaptureRequest } from '../Core/EstuaryEvents';
import { SessionInfo } from '../Models/SessionInfo';
import { BotResponse } from '../Models/BotResponse';
import { BotVoice } from '../Models/BotVoice';
import { SttResponse } from '../Models/SttResponse';
import { InterruptData } from '../Models/InterruptData';

/**
 * Event types for EstuaryCharacter
 */
export interface EstuaryCharacterEvents {
    connected: (sessionInfo: SessionInfo) => void;
    disconnected: () => void;
    botResponse: (response: BotResponse) => void;
    voiceReceived: (voice: BotVoice) => void;
    transcript: (response: SttResponse) => void;
    interrupt: (data: InterruptData) => void;
    error: (error: string) => void;
    connectionStateChanged: (state: ConnectionState) => void;
    cameraCaptureRequest: (request: CameraCaptureRequest) => void;
}

/**
 * EstuaryCharacter - Represents an AI character for conversations.
 * Implements IEstuaryCharacterHandler to receive events from EstuaryManager.
 * 
 * Voice playback is handled externally - subscribe to 'voiceReceived' event
 * and use DynamicAudioOutput from RemoteServiceGateway.lspkg.
 */
export class EstuaryCharacter 
    extends EventEmitter<any> 
    implements IEstuaryCharacterHandler {

    // ==================== Configuration ====================

    /** The character ID from the Estuary dashboard */
    private _characterId: string = '';

    /** Unique player identifier for conversation persistence */
    private _playerId: string = '';

    /** Automatically connect when initialized */
    private _autoConnect: boolean = true;

    /** Automatically reconnect if connection is lost */
    private _autoReconnect: boolean = true;

    // ==================== State ====================

    /** Whether this character is currently connected */
    private _isConnected: boolean = false;

    /** Current session information */
    private _currentSession: SessionInfo | null = null;

    /** Whether a voice session is currently active */
    private _isVoiceSessionActive: boolean = false;

    /** Flag to log voice session warning only once */
    private _voiceSessionWarningLogged: boolean = false;

    /** The current partial response being built (for streaming) */
    private _currentPartialResponse: string = '';

    /** The message ID currently being processed */
    private _currentMessageId: string = '';

    /** The message ID that was interrupted (for filtering late-arriving audio) */
    private _interruptedMessageId: string = '';

    // ==================== References ====================

    /** Microphone for voice input */
    private _microphone: IEstuaryMicrophoneController | null = null;

    // ==================== Constructor ====================

    constructor(characterId: string = '', playerId: string = '') {
        super();
        this._characterId = characterId;
        this._playerId = playerId || this.generatePlayerId();
    }

    // ==================== Properties ====================

    get characterId(): string {
        return this._characterId;
    }

    set characterId(value: string) {
        this._characterId = value;
    }

    get playerId(): string {
        return this._playerId;
    }

    set playerId(value: string) {
        this._playerId = value;
    }

    get autoConnect(): boolean {
        return this._autoConnect;
    }

    set autoConnect(value: boolean) {
        this._autoConnect = value;
    }

    get autoReconnect(): boolean {
        return this._autoReconnect;
    }

    set autoReconnect(value: boolean) {
        this._autoReconnect = value;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    get currentSession(): SessionInfo | null {
        return this._currentSession;
    }

    get isVoiceSessionActive(): boolean {
        return this._isVoiceSessionActive;
    }

    get currentPartialResponse(): string {
        return this._currentPartialResponse;
    }

    get currentMessageId(): string {
        return this._currentMessageId;
    }

    /** Set the microphone for voice input */
    set microphone(mic: IEstuaryMicrophoneController | null) {
        this._microphone = mic;
    }

    // ==================== Public Methods ====================

    /**
     * Initialize the character and optionally connect.
     * @param config Configuration for the connection
     */
    initialize(config: EstuaryConfig): void {
        // Set config on manager
        EstuaryManager.instance.config = config;

        // Register with manager
        EstuaryManager.instance.registerCharacter(this);

        if (this._autoConnect) {
            this.connect();
        }
    }

    /**
     * Connect to the Estuary server for this character.
     */
    connect(): void {
        if (!this._characterId) {
            print(`[EstuaryCharacter] Cannot connect: CharacterId is not set`);
            return;
        }

        if (!this._playerId) {
            this._playerId = this.generatePlayerId();
        }

        // Make this the active character and connect
        EstuaryManager.instance.setActiveCharacter(this);
        EstuaryManager.instance.connect();
    }

    /**
     * Disconnect from the server.
     */
    disconnect(): void {
        EstuaryManager.instance.disconnect();
    }

    /**
     * Send a text message to this character.
     * @param message The message to send
     */
    sendText(message: string): void {
        if (!this._isConnected) {
            print(`[EstuaryCharacter] Cannot send text: not connected`);
            return;
        }

        if (!message || message.trim().length === 0) {
            print(`[EstuaryCharacter] Cannot send empty message`);
            return;
        }

        // Reset partial response state
        this._currentPartialResponse = '';
        this._currentMessageId = '';

        EstuaryManager.instance.sendText(message);
    }

    /**
     * Start a voice session for this character.
     */
    startVoiceSession(): void {
        if (!this._isConnected) {
            print(`[EstuaryCharacter] Cannot start voice session: not connected`);
            return;
        }

        this._isVoiceSessionActive = true;
        this._voiceSessionWarningLogged = false;
        this._currentPartialResponse = '';
        this._currentMessageId = '';

        // Tell server to start voice mode (enables Deepgram STT)
        EstuaryManager.instance.startVoiceMode();

        print(`[EstuaryCharacter] Voice session started for ${this._characterId}`);

        // Start microphone if available
        if (this._microphone) {
            this._microphone.startRecording();
        }
    }

    /**
     * End the current voice session.
     */
    endVoiceSession(): void {
        this._isVoiceSessionActive = false;

        // Tell server to stop voice mode (saves STT costs)
        EstuaryManager.instance.stopVoiceMode();

        print(`[EstuaryCharacter] Voice session ended for ${this._characterId}`);

        // Stop microphone if available
        if (this._microphone) {
            this._microphone.stopRecording();
        }
    }

    /**
     * Stream audio data for speech-to-text.
     * @param audioBase64 Base64-encoded audio data
     */
    streamAudio(audioBase64: string): void {
        if (!this._isConnected) {
            return;
        }
        
        if (!this._isVoiceSessionActive) {
            if (!this._voiceSessionWarningLogged) {
                print('[EstuaryCharacter] ⚠️ Audio dropped: voice session not active! Call startVoiceSession() first.');
                this._voiceSessionWarningLogged = true;
            }
            return;
        }

        EstuaryManager.instance.streamAudio(audioBase64);
    }

    /**
     * Signal that the current response should be interrupted.
     * Emits 'interrupt' event - handle audio stopping externally.
     */
    interrupt(): void {
        // Store the current message ID as interrupted so late-arriving audio is filtered
        if (this._currentMessageId) {
            this._interruptedMessageId = this._currentMessageId;
        }
        
        this._currentPartialResponse = '';
        this._currentMessageId = '';
        this.emit('interrupt', { messageId: this._interruptedMessageId, reason: 'user_interrupt' });
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        EstuaryManager.instance.unregisterCharacter(this);
        this.removeAllListeners();
    }

    // ==================== IEstuaryCharacterHandler Implementation ====================

    handleSessionConnected(sessionInfo: SessionInfo): void {
        this._isConnected = true;
        this._currentSession = sessionInfo;

        print(`[EstuaryCharacter] Connected: ${JSON.stringify(sessionInfo)}`);

        this.emit('connected', sessionInfo);
    }

    handleDisconnected(reason: string): void {
        this._isConnected = false;
        this._currentSession = null;
        this._isVoiceSessionActive = false;

        print(`[EstuaryCharacter] Disconnected: ${reason}`);

        this.emit('disconnected');

        // Auto-reconnect if enabled
        if (this._autoReconnect && reason !== 'client disconnect') {
            print(`[EstuaryCharacter] Auto-reconnecting...`);
            this.connect();
        }
    }

    handleBotResponse(response: BotResponse): void {
        // Track message ID and clear interrupted state for new messages
        if (response.messageId) {
            // If this is a new message, clear the interrupted message ID
            if (this._currentMessageId !== response.messageId) {
                this._interruptedMessageId = '';
            }
            this._currentMessageId = response.messageId;
        }

        // Handle streaming responses
        if (response.isFinal) {
            this._currentPartialResponse = response.text;
        } else {
            this._currentPartialResponse += response.text;
        }

        this.emit('botResponse', response);
    }

    handleBotVoice(voice: BotVoice): void {
        // Filter out audio for interrupted messages
        if (this._interruptedMessageId && voice.messageId === this._interruptedMessageId) {
            // This audio belongs to an interrupted message - discard it
            return;
        }

        // If this is a new message, clear the interrupted state
        if (voice.messageId && this._currentMessageId !== voice.messageId) {
            this._interruptedMessageId = '';
            this._currentMessageId = voice.messageId;
        }

        // Emit event for external handling (e.g., DynamicAudioOutput)
        this.emit('voiceReceived', voice);
    }

    handleSttResponse(response: SttResponse): void {
        this.emit('transcript', response);
    }

    handleInterrupt(data: InterruptData): void {
        // Store the interrupted message ID so we can filter late-arriving audio
        if (data.messageId) {
            this._interruptedMessageId = data.messageId;
        } else if (this._currentMessageId) {
            // If no messageId in interrupt data, use the current message ID
            this._interruptedMessageId = this._currentMessageId;
        }
        
        this._currentPartialResponse = '';
        this._currentMessageId = '';
        this.emit('interrupt', data);
    }

    handleError(error: string): void {
        print(`[EstuaryCharacter] Error: ${error}`);
        this.emit('error', error);
    }

    handleConnectionStateChanged(state: ConnectionState): void {
        this.emit('connectionStateChanged', state);
    }

    handleCameraCaptureRequest(request: CameraCaptureRequest): void {
        print('');
        print('📷 ========================================');
        print('📷 CAMERA CAPTURE REQUESTED!');
        print(`📷 Subscribe to 'cameraCaptureRequest' event to handle this.`);
        print(`📷 Then call sendCameraImage() with the captured image.`);
        print('📷 ========================================');
        print('');
        this.emit('cameraCaptureRequest', request);
    }

    // ==================== Private Methods ====================

    private generatePlayerId(): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 10);
        return `player_${timestamp}_${random}`;
    }
}

/**
 * Interface for microphone controller.
 */
export interface IEstuaryMicrophoneController {
    startRecording(): void;
    stopRecording(): void;
}
