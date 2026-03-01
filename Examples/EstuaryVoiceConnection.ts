/**
 * EstuaryVoiceConnection.ts
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
 * 8. Add the CameraCapture component to enable vision (responds to server-initiated requests)
 * 
 * IMPORTANT: Your character must have a voice configured in the Estuary dashboard,
 * otherwise responses will be text-only (no TTS audio).
 * 
 * Vision: When the user says something visual (e.g. "what do you think of this vase?"),
 * the backend's agentic tool router detects the intent and sends a camera_capture request
 * to the SDK. The CameraCapture component handles capturing and sending the image back.
 * No client-side vision intent detection is needed.
 */

import { EstuaryCharacter } from '../src/Components/EstuaryCharacter';
import { EstuaryMicrophone, MicrophoneRecorder } from '../src/Components/EstuaryMicrophone';
import { EstuaryCredentials, IEstuaryCredentials, getCredentialsFromSceneObject } from '../src/Components/EstuaryCredentials';
import { EstuaryActionManager, EstuaryActions } from '../src/Components/EstuaryActionManager';
import { EstuaryManager } from '../src/Components/EstuaryManager';
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
export class EstuaryVoiceConnection extends BaseScriptComponent {
    
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
    private dynamicAudioOutput: DynamicAudioOutput | null = null;
    private playerId: string = "";
    private updateEvent: SceneEvent | null = null;
    private audioInitialized: boolean = false;
    
    // ==================== Inactivity Tracking ====================
    
    /** Last activity timestamp (ms) */
    private lastActivityTime: number = 0;
    
    /** Inactivity timeout in ms (10 minutes) */
    private readonly INACTIVITY_TIMEOUT_MS: number = 10 * 60 * 1000;
    
    /** Whether we've already disconnected due to inactivity */
    private disconnectedDueToInactivity: boolean = false;
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        this.log("Initializing...");
        
        // Get credentials from the referenced SceneObject or singleton
        this.credentials = this.getCredentials();
        if (!this.credentials) {
            print("[EstuaryVoiceConnection] ERROR: No EstuaryCredentials found!");
            print("[EstuaryVoiceConnection] Either set credentialsObject input OR add EstuaryCredentials to your scene");
            return;
        }
        
        // Set up InternetModule for WebSocket connections (required for Lens Studio 5.9+)
        if (this.internetModule) {
            setInternetModule(this.internetModule);
            this.log("InternetModule configured");
        } else {
            print("[EstuaryVoiceConnection] ERROR: InternetModule is required! Add it to your scene and connect it.");
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
        
        // Connect immediately — credentials and modules are already resolved
        this.connect();
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
            print("[EstuaryVoiceConnection] ERROR: No credentials available!");
            return;
        }
        
        if (!this.credentials.characterId) {
            print("[EstuaryVoiceConnection] ERROR: characterId is required!");
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
        
        // Create microphone (VAD is handled by Deepgram backend).
        // NOTE: Hardware component discovery (MicrophoneRecorder, DynamicAudioOutput)
        // is deferred to the 'connected' callback so that package scripts from
        // RemoteServiceGateway.lspkg have time to initialize their APIs.
        this.microphone = new EstuaryMicrophone(this.character);
        this.microphone.debugLogging = this.credentials!.debugMode;
        
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
        
        // Connected - discover hardware components, then start voice + mic
        this.character.on('connected', (session: SessionInfo) => {
            this.log(`Connected! Session: ${session.sessionId}`);
            
            // Initialize activity tracking
            this.recordActivity();
            this.disconnectedDueToInactivity = false;
            
            // Discover hardware components now — by the time the WebSocket
            // handshake completes, all package scripts will have initialised.
            this.discoverHardwareComponents();
            
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
    
    // ==================== Hardware Component Discovery ====================
    
    /**
     * Discover DynamicAudioOutput and MicrophoneRecorder on the referenced
     * SceneObjects.  This is called from the 'connected' callback instead of
     * from connect() so that package scripts from RemoteServiceGateway.lspkg
     * have had time to run their onAwake() and expose their APIs.
     */
    private discoverHardwareComponents(): void {
        // Skip if already discovered (e.g. on reconnect)
        if (!this.dynamicAudioOutput) {
            this.discoverDynamicAudioOutput();
        }
        if (this.microphone && !this.microphone.isRecording) {
            this.discoverMicrophoneRecorder();
        }
    }
    
    /**
     * Find the DynamicAudioOutput script on the configured SceneObject.
     */
    private discoverDynamicAudioOutput(): void {
        if (!this.dynamicAudioOutputObject) {
            print("[EstuaryVoiceConnection] WARNING: No dynamicAudioOutputObject configured - voice responses won't be played");
            return;
        }
        
        const scripts = this.dynamicAudioOutputObject.getComponents("Component.ScriptComponent") as any[];
        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (sc && typeof sc.initialize === 'function' && typeof sc.addAudioFrame === 'function') {
                this.dynamicAudioOutput = sc as DynamicAudioOutput;
                break;
            }
        }
        
        if (this.dynamicAudioOutput) {
            this.dynamicAudioOutput.initialize(this.audioSampleRate);
            this.audioInitialized = true;
            this.log(`DynamicAudioOutput configured (${this.audioSampleRate}Hz)`);

            // Set AudioComponent to Low Latency mode for faster TTS playback on Spectacles
            const audioComp = this.dynamicAudioOutputObject.getComponent("Component.AudioComponent");
            if (audioComp) {
                (audioComp as AudioComponent).playbackMode = Audio.PlaybackMode.LowLatency;
                this.log("AudioComponent set to Low Latency mode");
            }
        } else {
            print("[EstuaryVoiceConnection] WARNING: Could not find DynamicAudioOutput script on object");
        }
    }
    
    /**
     * Find the MicrophoneRecorder script on the configured SceneObject.
     */
    private discoverMicrophoneRecorder(): void {
        if (!this.microphoneRecorderObject) {
            print("[EstuaryVoiceConnection] ERROR: No microphoneRecorderObject configured!");
            return;
        }
        
        this.log('Searching for MicrophoneRecorder...');
        
        const sceneObj = this.microphoneRecorderObject;
        let micRecorder: MicrophoneRecorder | null = null;
        
        const scripts = sceneObj.getComponents("Component.ScriptComponent") as any[];
        this.log(`Found ${scripts.length} ScriptComponent(s) on object`);
        
        for (let i = 0; i < scripts.length; i++) {
            const scriptComp = scripts[i] as any;
            if (!scriptComp) continue;
            
            // Check if this script has onAudioFrame (MicrophoneRecorder signature)
            if (scriptComp.onAudioFrame && typeof scriptComp.startRecording === 'function') {
                this.log('Found MicrophoneRecorder directly on script component');
                micRecorder = scriptComp as MicrophoneRecorder;
                break;
            }
            
            // Check .api property (deprecated but may still work)
            if (scriptComp.api && scriptComp.api.onAudioFrame) {
                this.log('Found MicrophoneRecorder via .api property');
                micRecorder = scriptComp.api as MicrophoneRecorder;
                break;
            }
            
            // Log ALL available properties on detection failure for debugging
            if (this.credentials?.debugMode) {
                const props: string[] = [];
                for (const key in scriptComp) {
                    props.push(key);
                }
                this.log(`Script ${i} properties (${props.length}): ${props.join(', ')}`);
                // Also log .api sub-properties if present
                if (scriptComp.api) {
                    const apiProps: string[] = [];
                    for (const key in scriptComp.api) {
                        apiProps.push(key);
                    }
                    this.log(`Script ${i} .api properties (${apiProps.length}): ${apiProps.join(', ')}`);
                }
            }
        }
        
        if (micRecorder) {
            this.microphone!.setMicrophoneRecorder(micRecorder);
            this.character!.microphone = this.microphone;
            this.log('MicrophoneRecorder configured successfully');
        } else {
            print("[EstuaryVoiceConnection] ERROR: Could not find MicrophoneRecorder API on any script component");
        }
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

        // ALWAYS process send queue every frame — even during Connecting state.
        // Protocol messages (pong "3", auth "40/sdk,...") get stuck in the queue
        // with no tick() to drain them on Spectacles if we only tick when connected.
        // The 75ms min send gap is enforced inside processSendQueue(), so calling
        // tick() every frame (~16ms at 60fps) is safe and reduces queue latency.
        EstuaryManager.instance.tick();

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
        print(`[EstuaryVoiceConnection] Disconnected: ${reason}`);
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


    /** Whether the microphone is currently muted (not recording) */
    get isMuted(): boolean {
        return this.microphone ? !this.microphone.isRecording : true;
    }

    /** Toggle mute state. Returns true if now muted, false if now unmuted. */
    toggleMute(): boolean {
        if (this.microphone) {
            this.microphone.toggleRecording();
            const muted = !this.microphone.isRecording;
            print(`[EstuaryVoiceConnection] Mic ${muted ? 'MUTED' : 'UNMUTED'}`);
            return muted;
        }
        return true;
    }

    /** Set mute state explicitly */
    setMuted(muted: boolean): void {
        if (!this.microphone) return;
        if (muted && this.microphone.isRecording) {
            this.microphone.stopRecording();
        } else if (!muted && !this.microphone.isRecording) {
            this.microphone.startRecording();
        }
    }

    // ==================== Utility ====================
    
    private log(message: string): void {
        if (this.credentials?.debugMode) {
            print(`[EstuaryVoiceConnection] ${message}`);
        }
    }
}
