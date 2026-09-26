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
import { ClientActionEvent } from '../Models/ClientAction';
import { ConversationEvent, ConversationPayloads, ConversationEventHandlers, ModerationFlag, VoiceMode } from '../Models/ConversationEvents';

/**
 * Event types for EstuaryCharacter
 */
export interface EstuaryCharacterEvents extends ConversationEventHandlers {
    connected: (sessionInfo: SessionInfo) => void;
    disconnected: () => void;
    botResponse: (response: BotResponse) => void;
    clientAction: (action: ClientActionEvent) => void;
    voiceReceived: (voice: BotVoice) => void;
    voiceStarted: () => void;
    voiceError: (data: { error: string }) => void;
    responseRedacted: (flag: ModerationFlag) => void;
    disposed: () => void;
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
    extends EventEmitter<EstuaryCharacterEvents>
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

    /**
     * Set by session_timeout: the server ended the session on purpose (idle
     * reap), so the disconnect that follows must NOT trigger _autoReconnect —
     * reconnecting would re-establish billed backend resources with nobody
     * talking, in a loop. Cleared on the next explicit connect().
     */
    private _serverEndedSession: boolean = false;

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
    private _blockedMessageIds = new Set<string>();
    private _partialMessageId = '';
    private _voiceMode: VoiceMode = 'continuous';
    private _voiceStartPending = false;
    private _voiceReleasePending = false;
    private _voiceStopPending = false;
    private _voiceRestartRequested: VoiceMode | null = null;

    /** Counter for streamed audio chunks (diagnostic) */
    private _audioStreamCount: number = 0;

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

        // Explicit user intent overrides a prior server idle timeout
        this._serverEndedSession = false;

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
    sendText(message: string, textOnly?: boolean): void {
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

        EstuaryManager.instance.sendText(message, textOnly);
    }

    /**
     * Script this character to say a specific prewritten line.
     * @param text The scripted line text
     * @param textOnly If true, text-only response (no TTS audio). Default false.
     */
    sayLine(text: string, textOnly: boolean = false): void {
        if (!this._isConnected) {
            print(`[EstuaryCharacter] Cannot say line: not connected`);
            return;
        }
        // Reset partial response state (new response incoming)
        this._currentPartialResponse = '';
        this._currentMessageId = '';
        EstuaryManager.instance.sayLine(text, textOnly);
    }

    /**
     * Start a voice session for this character.
     */
    startVoiceSession(mode: VoiceMode = this._voiceMode): void {
        if (!this._isConnected || this._serverEndedSession || this._isVoiceSessionActive) return;
        if (this._voiceMode === 'push_to_talk' && mode === 'continuous') {
            throw new Error('Push-to-talk lasts for the session. Reconnect to use continuous voice.');
        }
        if (this._voiceStartPending) {
            if (this._voiceReleasePending) this._voiceRestartRequested = mode;
            return;
        }
        if (this._voiceStopPending) { this._voiceRestartRequested = mode; return; }
        this._voiceMode = mode;
        this._voiceStartPending = true;
        this._voiceReleasePending = false;
        this._voiceSessionWarningLogged = false;
        this._audioStreamCount = 0;
        EstuaryManager.instance.startVoiceMode(mode);
        // Capture starts only after voice_started: the gateway may be opening STT asynchronously.
    }

    /** Press/release entry points for an app's button or pinch interaction. */
    beginPushToTalk(): void { this.startVoiceSession('push_to_talk'); }
    endPushToTalk(): void { this.endVoiceSession(); }

    handleVoiceStarted(_data: any): void {
        if (!this._voiceStartPending) return;
        this._voiceStartPending = false;
        if (this._voiceReleasePending) {
            this._voiceReleasePending = false;
            this.requestVoiceStop();
            return;
        }
        this._isVoiceSessionActive = true;
        this._microphone?.startRecording();
        this.emit('voiceStarted');
    }

    handleVoiceError(data: any): void {
        this.stopLocalVoice();
        this.emit('voiceError', data);
    }

    endVoiceSession(): void {
        this._voiceRestartRequested = null;
        if (this._voiceStartPending) {
            this._voiceReleasePending = true;
            return;
        }
        if (!this._isVoiceSessionActive) return;
        // stopRecording flushes the speech tail while streamAudio still accepts it.
        this._microphone?.stopRecording();
        this._isVoiceSessionActive = false;
        this.requestVoiceStop();
    }

    private requestVoiceStop(): void {
        this._voiceStopPending = true;
        EstuaryManager.instance.stopVoiceMode();
    }

    handleVoiceStopped(): void {
        this._voiceStopPending = false;
        const next = this._voiceRestartRequested;
        this._voiceRestartRequested = null;
        if (next) this.startVoiceSession(next);
    }

    /** Report a verified device playout completion, never text completion. */
    notifyAudioPlaybackComplete(messageId?: string): void {
        if (messageId && this._blockedMessageIds.has(messageId)) return;
        EstuaryManager.instance.notifyAudioPlaybackComplete(messageId);
    }

    private stopLocalVoice(): void {
        this._voiceStartPending = false;
        this._voiceReleasePending = false;
        this._voiceStopPending = false;
        this._voiceRestartRequested = null;
        this._isVoiceSessionActive = false;
        this._microphone?.stopRecording(false);
    }

    /**
     * Handle a server voice-idle release (voice_timeout).
     * After VOICE_IDLE_TIMEOUT_S without user speech the server closed the
     * STT stream but KEPT the socket — text chat continues. Stop the mic and
     * clear the voice-active flag locally so audio stops streaming into the
     * closed stream; deliberately does NOT emit stop_voice (the server-side
     * voice session is already gone). Resume = startVoiceSession() on user
     * intent — recommended UX is the auto-mute illusion (show the mic muted,
     * restart voice on unmute).
     */
    handleVoiceTimeout(data: any): void {
        this.stopLocalVoice();
        this.emit('voiceTimeout', data);
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

        this._audioStreamCount++;
        if (this._audioStreamCount === 1) {
            print(`[EstuaryCharacter] DIAG: First audio streamed to server (base64 length=${audioBase64.length})`);
        }

        EstuaryManager.instance.streamAudio(audioBase64);
    }

    /**
     * Signal that the current response should be interrupted.
     * Sends `client_interrupt` to the server so generation stops server-side,
     * then emits a local 'interrupt' event for audio-stop handlers.
     */
    interrupt(): void {
        // Store the current message ID as interrupted so late-arriving audio is filtered
        if (this._currentMessageId) {
            this._interruptedMessageId = this._currentMessageId;
            this._blockedMessageIds.add(this._currentMessageId);
        }

        // Notify server so it halts text/TTS generation for this message.
        EstuaryManager.instance.sendClientInterrupt(this._interruptedMessageId || undefined);

        this._currentPartialResponse = '';
        this._currentMessageId = '';
        this.emit('interrupt', {
            messageId: this._interruptedMessageId,
            reason: 'user_interrupt',
            interruptedAt: ''
        });
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        this.stopLocalVoice();
        this.emit('disposed');
        EstuaryManager.instance.unregisterCharacter(this);
        this.removeAllListeners();
    }

    // ==================== IEstuaryCharacterHandler Implementation ====================

    handleSessionConnected(sessionInfo: SessionInfo): void {
        this._isConnected = true;
        this._currentSession = sessionInfo;
        this._blockedMessageIds.clear();
        this._interruptedMessageId = '';
        this._partialMessageId = '';
        this._currentPartialResponse = '';
        this._currentMessageId = '';
        this._voiceMode = 'continuous';
        this._voiceStartPending = false;
        this._voiceReleasePending = false;
        this._voiceStopPending = false;
        this._voiceRestartRequested = null;

        print(`[EstuaryCharacter] Connected: ${JSON.stringify(sessionInfo)}`);

        this.emit('connected', sessionInfo);
    }

    handleDisconnected(reason: string): void {
        this._isConnected = false;
        this._currentSession = null;
        this.stopLocalVoice();

        print(`[EstuaryCharacter] Disconnected: ${reason}`);

        this.emit('disconnected');

        // Auto-reconnect if enabled — but NEVER after a server idle reap
        // (session_timeout): that would re-authenticate and re-establish
        // billed backend resources in a loop. Resume = explicit connect().
        if (this._autoReconnect && !this._serverEndedSession && reason !== 'client disconnect') {
            print(`[EstuaryCharacter] Auto-reconnecting...`);
            this.connect();
        }
    }

    /**
     * Handle a server idle reap (session_timeout). The server emits this and
     * then disconnects the socket — flag the session as server-ended so the
     * disconnect that follows skips auto-reconnect. Resume = explicit
     * connect() on user intent (see SDK_CONTRACT.md).
     */
    handleSessionTimeout(data: any): void {
        this._serverEndedSession = true;
        this.stopLocalVoice();
        this.emit('sessionTimeout', data);
    }

    handleConversationEvent<K extends ConversationEvent>(event: K, data: ConversationPayloads[K]): void {
        if (event === 'apiEndpointResult' && (this._serverEndedSession || this._blockedMessageIds.has((data as ConversationPayloads['apiEndpointResult']).message_id))) return;
        if (event === 'sessionRejected' || (event === 'moderationWarning' && (data as ConversationPayloads['moderationWarning']).level === 'terminated')) {
            this._serverEndedSession = true;
            this.stopLocalVoice();
        }
        if (event === 'moderationFlag') {
            const flag = data as ModerationFlag;
            this._blockedMessageIds.add(flag.message_id);
            if (flag.message_id === this._partialMessageId) this._currentPartialResponse = flag.message;
            this.emit('interrupt', { messageId: flag.message_id, reason: 'moderation', interruptedAt: '' });
            this.emit('responseRedacted', flag);
        }
        this.emit(event, data);
    }

    handleBotResponse(response: BotResponse): void {
        if (this._serverEndedSession || this._blockedMessageIds.has(response.messageId)) return;
        if (response.messageId && response.messageId !== this._partialMessageId) {
            this._currentPartialResponse = '';
            this._partialMessageId = response.messageId;
        }
        if (response.messageId) this._currentMessageId = response.messageId;
        this._currentPartialResponse = response.isFinal ? response.text : this._currentPartialResponse + response.text;
        this.emit('botResponse', response);
    }

    handleClientAction(action: ClientActionEvent): void {
        if (this._serverEndedSession || this._blockedMessageIds.has(action.messageId)) return;
        // Typed in-world action call (client_action, contract v1.9).
        // Re-emit for listeners — EstuaryActionManager subscribes here and
        // dispatches through the same actionTriggered / action:{name} events
        // as the legacy XML tag path.
        this.emit('clientAction', action);
    }

    handleBotVoice(voice: BotVoice): void {
        if (this._serverEndedSession || this._blockedMessageIds.has(voice.messageId)) return;
        if (voice.messageId) this._currentMessageId = voice.messageId;
        this.emit('voiceReceived', voice);
    }

    handleSttResponse(response: SttResponse): void {
        this.emit('transcript', response);
    }

    handleInterrupt(data: InterruptData): void {
        const id = data.messageId || this._currentMessageId;
        if (id) this._blockedMessageIds.add(id);
        this._interruptedMessageId = id;
        if (!id || id === this._currentMessageId) this._currentMessageId = '';
        if (!id || id === this._partialMessageId) this._currentPartialResponse = '';
        this.emit('interrupt', { ...data, messageId: id });
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
    stopRecording(flushPending?: boolean): void;
}
