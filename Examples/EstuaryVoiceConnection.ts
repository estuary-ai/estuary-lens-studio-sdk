/**
 * SimpleAutoConnect.ts
 * 
 * Auto-connects to Estuary and streams microphone audio continuously.
 * VAD is handled by the backend (Deepgram), so we just stream everything.
 * Supports both voice input (microphone) and voice output (TTS playback).
 * 
 * Setup in Lens Studio:
 * 1. Create a new Script component on a SceneObject
 * 2. Assign this script to the component
 * 3. Add an InternetModule to your scene and connect it to this script
 * 4. Add a MicrophoneRecorder component (from RemoteServiceGateway.lspkg):
 *    - Create a SceneObject with MicrophoneRecorder script
 *    - Connect the SceneObject to microphoneRecorderObject input
 * 5. Add DynamicAudioOutput for voice playback:
 *    - Create a SceneObject with DynamicAudioOutput script
 *    - Add an AudioComponent to the same SceneObject
 *    - Create an Audio Track asset and assign it to DynamicAudioOutput
 *    - Connect the SceneObject to dynamicAudioOutputObject input
 * 6. Set the serverUrl and characterId in the Inspector
 * 7. Make sure your character has a Voice Preset configured in the dashboard!
 * 
 * IMPORTANT: Your character must have a voice configured in the Estuary dashboard,
 * otherwise responses will be text-only (no TTS audio).
 */

import { EstuaryCharacter } from '../src/Components/EstuaryCharacter';
import { EstuaryMicrophone, MicrophoneRecorder } from '../src/Components/EstuaryMicrophone';
import { EstuaryCredentials, IEstuaryCredentials, getCredentialsFromSceneObject } from '../src/Components/EstuaryCredentials';
import { EstuaryActionManager, EstuaryActions } from '../src/Components/EstuaryActionManager';
import { EstuaryManager } from '../src/Components/EstuaryManager';
import { VisionIntentDetector } from '../src/Components/VisionIntentDetector';
import { EstuaryConfig } from '../src/Core/EstuaryConfig';
import { setInternetModule } from '../src/Core/EstuaryClient';
import { SessionInfo } from '../src/Models/SessionInfo';
import { BotResponse } from '../src/Models/BotResponse';
import { BotVoice } from '../src/Models/BotVoice';
import { SttResponse } from '../src/Models/SttResponse';

/**
 * Interface for DynamicAudioOutput from RemoteServiceGateway.lspkg
 * This component is attached to a SceneObject in Lens Studio.
 */
interface DynamicAudioOutput {
    initialize(sampleRate: number): void;
    addAudioFrame(uint8Array: Uint8Array, channels: number): void;
    interruptAudioOutput(): void;
}

@component
export class SimpleAutoConnect extends BaseScriptComponent {
    
    // ==================== Configuration (set in Inspector) ====================

    /**
     * Reference to the EstuaryCredentials SceneObject.
     * This contains your API key, character ID, and other settings.
     * Create a SceneObject with EstuaryCredentials script and drag it here.
     */
    @input
    @hint("SceneObject with EstuaryCredentials script (contains API key & character ID)")
    credentialsObject: SceneObject;
    
    /** Cached credentials reference */
    private credentials: IEstuaryCredentials | null = null;
    
    /** 
     * MicrophoneRecorder from RemoteServiceGateway.lspkg
     * This is the REQUIRED way to capture microphone audio in Lens Studio.
     * Provides event-based audio delivery that works reliably.
     * 
     * In Lens Studio: Drag the MicrophoneRecorder SceneObject here,
     * or use the picker to select the SceneObject containing MicrophoneRecorder.
     */
    @input
    @hint("SceneObject with MicrophoneRecorder script (REQUIRED)")
    microphoneRecorderObject: SceneObject;
    
    /** 
     * SceneObject with DynamicAudioOutput script for playing bot voice responses.
     * This is Snap's recommended approach for hardware-compatible audio playback.
     * 
     * Setup:
     * 1. Create a SceneObject
     * 2. Add the DynamicAudioOutput script to it
     * 3. Add an AudioComponent to the same SceneObject
     * 4. Create an Audio Track asset and assign it to DynamicAudioOutput's audioOutputTrack
     * 5. Drag the SceneObject here
     */
    @input
    @hint("SceneObject with DynamicAudioOutput script for voice playback")
    dynamicAudioOutputObject: SceneObject;

    /** InternetModule for WebSocket connections (required for Lens Studio 5.9+) */
    @input
    @hint("Connect the InternetModule from your scene")
    internetModule: InternetModule;
    
    // ==================== Vision Intent Detection (Natural Language Camera) ====================
    
    /**
     * Enable vision intent detection for natural language camera activation.
     * When enabled, phrases like "what do you think of this vase?" will trigger camera capture.
     * Uses smart heuristic detection - no additional API key needed!
     */
    @input
    @hint("Enable natural language camera activation (e.g., 'what do you think of this vase?')")
    enableVisionIntentDetection: boolean = true;
    
    /**
     * Confidence threshold for triggering camera capture (0-1).
     * Lower = more triggers, Higher = more selective.
     * Default 0.7 balances sensitivity with avoiding false triggers.
     */
    @input
    @hint("Confidence threshold for camera trigger (0.0-1.0)")
    visionConfidenceThreshold: number = 0.7;
    
    /** 
     * Default sample rate for audio playback.
     * 16000Hz is optimized for Snap Spectacles hardware.
     * Other platforms may use 48000Hz.
     */
    audioSampleRate: number = 16000;

    
    // ==================== Private Members ====================
    
    private character: EstuaryCharacter | null = null;
    private microphone: EstuaryMicrophone | null = null;
    private actionManager: EstuaryActionManager | null = null;
    private visionIntentDetector: VisionIntentDetector | null = null;
    private dynamicAudioOutput: DynamicAudioOutput | null = null;
    private playerId: string = "";
    private updateEvent: SceneEvent | null = null;
    private audioInitialized: boolean = false;
    
    // ==================== Inactivity Tracking ====================
    
    /** Last activity timestamp (ms) */
    private lastActivityTime: number = 0;
    
    /** Inactivity timeout in ms (10 minutes) */
    private readonly INACTIVITY_TIMEOUT_MS: number = 10 * 60 * 1000;
    
    /** Last queue tick timestamp */
    private lastTickTime: number = 0;
    
    /** Tick interval in ms (100ms - processes send queue to flush pending pong responses) */
    private readonly TICK_INTERVAL_MS: number = 100;
    
    /** Whether we've already disconnected due to inactivity */
    private disconnectedDueToInactivity: boolean = false;
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        this.log("Initializing...");
        
        // Get credentials from the referenced SceneObject or singleton
        this.credentials = this.getCredentials();
        if (!this.credentials) {
            print("[SimpleAutoConnect] ERROR: No EstuaryCredentials found!");
            print("[SimpleAutoConnect] Either set credentialsObject input OR add EstuaryCredentials to your scene");
            return;
        }
        
        // Set up InternetModule for WebSocket connections (required for Lens Studio 5.9+)
        if (this.internetModule) {
            setInternetModule(this.internetModule);
            this.log("InternetModule configured");
        } else {
            print("[SimpleAutoConnect] ERROR: InternetModule is required! Add it to your scene and connect it.");
            return;
        }
        
        // Get player ID from credentials (supports manual, persistent, or session-based IDs)
        if (this.credentials.userId && this.credentials.userId.length > 0) {
            this.playerId = this.credentials.userId;
            this.log(`Using User ID from credentials: ${this.playerId}`);
        } else {
            // Fallback to generated ID if credentials don't provide one
            this.playerId = "spectacles_" + Date.now().toString(36);
            this.log(`Using fallback generated User ID: ${this.playerId}`);
        }
        
        // Set up the update loop for audio processing
        this.updateEvent = this.createEvent("UpdateEvent");
        this.updateEvent.bind(() => this.onUpdate());
        
        // Auto-connect after a brief delay
        const delayedEvent = this.createEvent("DelayedCallbackEvent");
        delayedEvent.bind(() => this.connect());
        (delayedEvent as any).reset(0.5);
    }
    
    /**
     * Get credentials from the referenced SceneObject or singleton.
     */
    private getCredentials(): IEstuaryCredentials | null {
        // First try the input SceneObject
        if (this.credentialsObject) {
            const creds = getCredentialsFromSceneObject(this.credentialsObject);
            if (creds) {
                this.log("Using credentials from credentialsObject input");
                return creds;
            }
        }
        
        // Fall back to singleton
        if (EstuaryCredentials.hasInstance) {
            this.log("Using credentials from EstuaryCredentials singleton");
            return EstuaryCredentials.instance;
        }
        
        return null;
    }
    
    onDestroy() {
        this.disconnect();
    }
    
    // ==================== Connection ====================
    
    private connect(): void {
        if (!this.credentials) {
            print("[SimpleAutoConnect] ERROR: No credentials available!");
            return;
        }
        
        if (!this.credentials.characterId) {
            print("[SimpleAutoConnect] ERROR: characterId is required!");
            return;
        }
        
        this.log(`Connecting to ${this.credentials.serverUrl}...`);
        
        // Create the character
        this.character = new EstuaryCharacter(this.credentials.characterId, this.playerId);
        
        // Set up action manager for parsing action tags from responses
        this.actionManager = new EstuaryActionManager(this.character);
        this.actionManager.setCredentials(this.credentials);
        this.actionManager.debugLogging = this.credentials.debugMode;
        
        // Set up global action events - any script can now use EstuaryActions.on()
        EstuaryActions.setManager(this.actionManager);
        
        this.log("Action manager configured - EstuaryActions global events ready");
        
        // Set up vision intent detector for natural language camera activation
        if (this.enableVisionIntentDetection) {
            this.visionIntentDetector = new VisionIntentDetector({
                apiKey: '', // Uses heuristic detection - no external API needed
                confidenceThreshold: this.visionConfidenceThreshold,
                debugLogging: this.credentials!.debugMode
            });
            
            // Connect to character to listen for transcripts
            this.visionIntentDetector.startListening(this.character);
            
            this.log("Vision intent detection enabled");
            this.log("Natural language phrases like 'what do you think of this vase?' will now trigger camera");
        }
        
        // Set up DynamicAudioOutput for voice responses (Snap's recommended approach)
        if (this.dynamicAudioOutputObject) {
            // Find DynamicAudioOutput component on the SceneObject
            const componentCount = this.dynamicAudioOutputObject.getComponentCount("Component.ScriptComponent");
            for (let i = 0; i < componentCount; i++) {
                const scriptComp = this.dynamicAudioOutputObject.getComponentByIndex("Component.ScriptComponent", i) as any;
                if (scriptComp && typeof scriptComp.initialize === 'function' && typeof scriptComp.addAudioFrame === 'function') {
                    this.dynamicAudioOutput = scriptComp as DynamicAudioOutput;
                    break;
                }
            }
            
            if (this.dynamicAudioOutput) {
                // Initialize with sample rate - this starts the AudioComponent
                this.dynamicAudioOutput.initialize(this.audioSampleRate);
                this.audioInitialized = true;
                this.log(`DynamicAudioOutput configured (${this.audioSampleRate}Hz)`);
            } else {
                print("[SimpleAutoConnect] WARNING: Could not find DynamicAudioOutput script on object");
            }
        } else {
            print("[SimpleAutoConnect] WARNING: No dynamicAudioOutputObject configured - voice responses won't be played");
        }
        
        // Create microphone (VAD is handled by Deepgram backend)
        this.microphone = new EstuaryMicrophone(this.character);
        this.microphone.debugLogging = this.credentials!.debugMode;
        
        // Set up microphone - prefer MicrophoneRecorder (event-based, recommended)
        if (this.microphoneRecorderObject) {
            this.log('Searching for MicrophoneRecorder...');
            
            const sceneObj = this.microphoneRecorderObject;
            let micRecorder: MicrophoneRecorder | null = null;
            
            // Get all script components on the SceneObject
            const componentCount = sceneObj.getComponentCount("Component.ScriptComponent");
            this.log(`Found ${componentCount} ScriptComponent(s) on object`);
            
            for (let i = 0; i < componentCount; i++) {
                const scriptComp = sceneObj.getComponentByIndex("Component.ScriptComponent", i) as any;
                if (scriptComp) {
                    // Check if this script has onAudioFrame (MicrophoneRecorder signature)
                    if (scriptComp.onAudioFrame && typeof scriptComp.startRecording === 'function') {
                        this.log('Found MicrophoneRecorder directly on script component');
                        micRecorder = scriptComp as MicrophoneRecorder;
                        break;
                    }
                    
                    // Check .api property
                    if (scriptComp.api && scriptComp.api.onAudioFrame) {
                        this.log('Found MicrophoneRecorder via .api property');
                        micRecorder = scriptComp.api as MicrophoneRecorder;
                        break;
                    }
                    
                    // Log available properties for debugging
                    if (this.credentials?.debugMode) {
                        const props: string[] = [];
                        for (const key in scriptComp) {
                            props.push(key);
                        }
                        this.log(`Script ${i} properties: ${props.slice(0, 10).join(', ')}${props.length > 10 ? '...' : ''}`);
                    }
                }
            }
            
            if (micRecorder) {
                this.microphone.setMicrophoneRecorder(micRecorder);
                this.character.microphone = this.microphone;
                this.log('MicrophoneRecorder configured successfully');
            } else {
                print("[SimpleAutoConnect] ERROR: Could not find MicrophoneRecorder API on any script component");
            }
        } else {
            print("[SimpleAutoConnect] ERROR: No microphoneRecorderObject configured!");
        }
        
        // Set up event handlers
        this.setupEventHandlers();
        
        // Connect
        const config: EstuaryConfig = {
            serverUrl: this.credentials!.serverUrl,
            apiKey: this.credentials!.apiKey,
            characterId: this.credentials!.characterId,
            playerId: this.playerId,
            debugLogging: this.credentials!.debugMode
        };
        
        this.character.initialize(config);
    }
    
    private disconnect(): void {
        if (this.microphone) {
            this.microphone.stopRecording();
            this.microphone.dispose();
            this.microphone = null;
        }
        if (this.actionManager) {
            this.actionManager.dispose();
            this.actionManager = null;
        }
        if (this.visionIntentDetector) {
            this.visionIntentDetector.dispose();
            this.visionIntentDetector = null;
        }
        if (this.dynamicAudioOutput) {
            this.dynamicAudioOutput.interruptAudioOutput();
            this.dynamicAudioOutput = null;
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
            this.log(`Connected! Session: ${session.sessionId}`);
            
            // Initialize activity tracking
            this.recordActivity();
            this.lastTickTime = Date.now();
            this.disconnectedDueToInactivity = false;
            
            // Start voice session FIRST - this enables audio streaming
            this.character!.startVoiceSession();
            
            // Then start mic streaming
            this.startMicStream();
        });
        
        // Disconnected - show obvious log
        this.character.on('disconnected', () => {
            if (!this.disconnectedDueToInactivity) {
                // Disconnected by server or other reason (not our inactivity timeout)
                this.logDisconnect("Connection closed by server");
            }
            if (this.microphone) {
                this.microphone.stopRecording();
            }
        });
        
        // AI response (text)
        this.character.on('botResponse', (response: BotResponse) => {
            // Record activity - conversation is happening
            this.recordActivity();
            if (response.isFinal) {
                print(`[AI] ${response.text}`);
            }
        });
        
        // AI voice response (audio) - play using DynamicAudioOutput
        this.character.on('voiceReceived', (voice: BotVoice) => {
            // Record activity - voice response received
            this.recordActivity();
            
            if (this.credentials?.debugMode) {
                this.log(`Voice audio received: ${voice.audio?.length || 0} chars base64, chunk ${voice.chunkIndex}`);
            }
            
            // Play audio using DynamicAudioOutput (hardware-compatible)
            if (this.dynamicAudioOutput && voice.audio && voice.audio.length > 0) {
                // Decode base64 to PCM16 bytes using native Lens Studio Base64
                const pcmBytes = Base64.decode(voice.audio);
                this.dynamicAudioOutput.addAudioFrame(pcmBytes, 1);
            }
        });
        
        // Handle interrupts - stop audio when user starts speaking
        this.character.on('interrupt', () => {
            // Record activity - user interrupted
            this.recordActivity();
            if (this.dynamicAudioOutput) {
                this.dynamicAudioOutput.interruptAudioOutput();
                this.log("Audio interrupted");
            }
        });
        
        // STT from Deepgram
        this.character.on('transcript', (stt: SttResponse) => {
            // Record activity - user is speaking
            this.recordActivity();
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
        // MicrophoneRecorder uses event-based delivery, no per-frame processing needed
        // DynamicAudioOutput handles audio playback internally via native AudioComponent
        
        // Check for inactivity timeout and process send queue
        this.checkInactivityAndTick();
    }
    
    /**
     * Check for inactivity timeout and process send queue.
     * Disconnects after 10 minutes of no user activity.
     */
    private checkInactivityAndTick(): void {
        const now = Date.now();

        // ALWAYS process send queue — even during Connecting state.
        // Protocol messages (pong "3", auth "40/sdk,...") get stuck in the queue
        // with no tick() to drain them on Spectacles if we only tick when connected.
        if (now - this.lastTickTime >= this.TICK_INTERVAL_MS) {
            this.lastTickTime = now;
            EstuaryManager.instance.tick();
        }

        // Inactivity check only applies when connected
        if (!this.character?.isConnected) {
            return;
        }

        // Check for inactivity timeout (10 minutes)
        if (this.lastActivityTime > 0) {
            const inactiveTime = now - this.lastActivityTime;
            if (inactiveTime >= this.INACTIVITY_TIMEOUT_MS && !this.disconnectedDueToInactivity) {
                this.disconnectedDueToInactivity = true;

                // Disable auto-reconnect so it stays disconnected
                this.character.autoReconnect = false;

                this.logDisconnect("INACTIVITY TIMEOUT - No activity for 10 minutes");
                this.character.disconnect();
                return;
            }
        }
    }
    
    /**
     * Record user activity to reset the inactivity timer.
     * Called when user sends audio, text, or interacts with the system.
     */
    private recordActivity(): void {
        this.lastActivityTime = Date.now();
        this.disconnectedDueToInactivity = false;
    }
    
    /**
     * Log a disconnect event.
     */
    private logDisconnect(reason: string): void {
        print(`[SimpleAutoConnect] Disconnected: ${reason}`);
    }
    
    // ==================== Public Methods ====================
    
    /** Send a text message to the AI */
    sendMessage(text: string): void {
        if (this.character?.isConnected) {
            // Record activity - user is sending a message
            this.recordActivity();
            this.character.sendText(text);
        }
    }
    
    /** Get the action manager for subscribing to actions */
    getActionManager(): EstuaryActionManager | null {
        return this.actionManager;
    }
    
    /** Get the character instance */
    getCharacter(): EstuaryCharacter | null {
        return this.character;
    }
    
    /** Get the vision intent detector for natural language camera activation */
    getVisionIntentDetector(): VisionIntentDetector | null {
        return this.visionIntentDetector;
    }
    
    // ==================== Utility ====================
    
    private log(message: string): void {
        if (this.credentials?.debugMode) {
            print(`[SimpleAutoConnect] ${message}`);
        }
    }
}
