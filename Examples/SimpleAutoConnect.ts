/**
 * SimpleAutoConnect.ts
 * 
 * Auto-connects to Estuary and streams microphone audio continuously.
 * VAD is handled by the backend (Deepgram), so we just stream everything.
 * 
 * Setup in Lens Studio:
 * 1. Create a new Script component on a SceneObject
 * 2. Assign this script to the component
 * 3. Create an AudioTrackAsset for microphone input and assign it
 * 4. Set the serverUrl and characterId in the Inspector
 */

import { EstuaryCharacter } from '../src/Components/EstuaryCharacter';
import { EstuaryMicrophone, AudioInputControl } from '../src/Components/EstuaryMicrophone';
import { EstuaryConfig } from '../src/Core/EstuaryConfig';
import { SessionInfo } from '../src/Models/SessionInfo';
import { BotResponse } from '../src/Models/BotResponse';
import { SttResponse } from '../src/Models/SttResponse';

@component
export class SimpleAutoConnect extends BaseScriptComponent {
    
    // ==================== Configuration (set in Inspector) ====================
    
    /** Your Estuary server URL */
    @input
    @hint("Estuary server WebSocket URL")
    serverUrl: string = "ws://localhost:4001";
    
    /** The character/agent ID to connect to */
    @input
    @hint("Character/Agent ID from your Estuary backend")
    characterId: string = "3799f1e4-1b67-426f-a342-65d40afc89e4";
    
    /** Audio input for microphone streaming */
    @input
    @hint("AudioTrackAsset for microphone input")
    audioInput: AudioTrackAsset;
    
    /** Optional: API key if your server requires it */
    @input
    apiKey: string = "est_QZV8LFmvBgq3rBfK39x22aWL_ukR4jd_cH7vBFGr4MU";
    
    /** Enable debug logging */
    @input
    debugMode: boolean = true;
    
    // ==================== Private Members ====================
    
    private character: EstuaryCharacter | null = null;
    private microphone: EstuaryMicrophone | null = null;
    private playerId: string = "";
    private updateEvent: SceneEvent | null = null;
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        this.log("Initializing...");
        
        // Generate a unique player ID
        this.playerId = "spectacles_" + Date.now().toString(36);
        
        // Set up the update loop for audio processing
        this.updateEvent = this.createEvent("UpdateEvent");
        this.updateEvent.bind(() => this.onUpdate());
        
        // Auto-connect after a brief delay
        const delayedEvent = this.createEvent("DelayedCallbackEvent");
        delayedEvent.bind(() => this.connect());
        (delayedEvent as any).reset(0.5);
    }
    
    onDestroy() {
        this.disconnect();
    }
    
    // ==================== Connection ====================
    
    private connect(): void {
        if (!this.characterId) {
            print("[SimpleAutoConnect] ERROR: characterId is required!");
            return;
        }
        
        this.log(`Connecting to ${this.serverUrl}...`);
        
        // Create the character
        this.character = new EstuaryCharacter(this.characterId, this.playerId);
        
        // Create microphone (VAD disabled - backend handles it)
        this.microphone = new EstuaryMicrophone(this.character);
        this.microphone.useVoiceActivityDetection = false; // Backend has Deepgram VAD
        this.microphone.debugLogging = this.debugMode;
        
        // Set up audio input if available
        if (this.audioInput) {
            const inputControl = this.audioInput.control as AudioInputControl;
            this.microphone.setAudioInput(inputControl);
            this.character.microphone = this.microphone;
        } else {
            print("[SimpleAutoConnect] WARNING: No audioInput assigned - mic streaming won't work");
        }
        
        // Set up event handlers
        this.setupEventHandlers();
        
        // Connect
        const config: EstuaryConfig = {
            serverUrl: this.serverUrl,
            apiKey: this.apiKey,
            characterId: this.characterId,
            playerId: this.playerId,
            debugLogging: this.debugMode
        };
        
        this.character.initialize(config);
    }
    
    private disconnect(): void {
        if (this.microphone) {
            this.microphone.stopRecording();
            this.microphone.dispose();
            this.microphone = null;
        }
        if (this.character) {
            this.character.dispose();
            this.character = null;
        }
    }
    
    // ==================== Event Handlers ====================
    
    private setupEventHandlers(): void {
        if (!this.character) return;
        
        // Connected - start streaming mic immediately
        this.character.on('connected', (session: SessionInfo) => {
            print("===========================================");
            print("  Connected! Starting mic stream...");
            print(`  Session: ${session.sessionId}`);
            print("===========================================");
            
            // Start mic streaming immediately
            this.startMicStream();
        });
        
        // Disconnected
        this.character.on('disconnected', () => {
            this.log("Disconnected");
            if (this.microphone) {
                this.microphone.stopRecording();
            }
        });
        
        // AI response
        this.character.on('botResponse', (response: BotResponse) => {
            if (response.isFinal) {
                print(`[AI] ${response.text}`);
            }
        });
        
        // STT from Deepgram
        this.character.on('transcript', (stt: SttResponse) => {
            if (stt.isFinal) {
                print(`[You] ${stt.text}`);
            }
        });
        
        // Errors
        this.character.on('error', (error: string) => {
            print(`[Error] ${error}`);
        });
    }
    
    private startMicStream(): void {
        if (this.microphone) {
            this.microphone.startRecording();
            this.log("Mic streaming started");
        }
    }
    
    // ==================== Update Loop ====================
    
    private onUpdate(): void {
        // Process microphone audio every frame
        if (this.microphone && this.microphone.isRecording) {
            this.microphone.processAudioFrame(1024);
        }
    }
    
    // ==================== Public Methods ====================
    
    /** Send a text message to the AI */
    sendMessage(text: string): void {
        if (this.character?.isConnected) {
            this.character.sendText(text);
        }
    }
    
    // ==================== Utility ====================
    
    private log(message: string): void {
        if (this.debugMode) {
            print(`[SimpleAutoConnect] ${message}`);
        }
    }
}
