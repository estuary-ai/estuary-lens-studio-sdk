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
 *    - This is the RECOMMENDED way to capture microphone audio
 *    - Provides event-based audio delivery (works in simulator!)
 * 5. Add an Audio Track asset for voice playback:
 *    - Asset Browser → "+" → Audio → Audio Track
 *    - Connect it to the audioOutput input
 * 6. Set the serverUrl and characterId in the Inspector
 * 7. Make sure your character has a Voice Preset configured in the dashboard!
 * 
 * IMPORTANT: Your character must have a voice configured in the Estuary dashboard,
 * otherwise responses will be text-only (no TTS audio).
 * 
 * RECOMMENDED: Use MicrophoneRecorder from RemoteServiceGateway.lspkg
 * This is what the official Gemini voice chat example uses.
 * 
 * Alternative: Use "Audio From Microphone" asset (less reliable in simulator)
 */

import { EstuaryCharacter } from '../src/Components/EstuaryCharacter';
import { EstuaryMicrophone, MicrophoneAudioProvider, MicrophoneRecorder } from '../src/Components/EstuaryMicrophone';
import { EstuaryAudioPlayer, AudioOutputControl } from '../src/Components/EstuaryAudioPlayer';
import { EstuaryConfig } from '../src/Core/EstuaryConfig';
import { setInternetModule } from '../src/Core/EstuaryClient';
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
    
    /** 
     * RECOMMENDED: MicrophoneRecorder from RemoteServiceGateway.lspkg
     * This is what the official Gemini voice chat example uses.
     * Provides event-based audio delivery that works reliably.
     * 
     * In Lens Studio: Drag the MicrophoneRecorder SceneObject here,
     * or use the picker to select the SceneObject containing MicrophoneRecorder.
     */
    @input
    @hint("SceneObject with MicrophoneRecorder script")
    microphoneRecorderObject: SceneObject;
    
    /** 
     * Alternative: Audio From Microphone asset for raw PCM audio access.
     * Only used if MicrophoneRecorder is not provided.
     * In Lens Studio: Asset Browser → "+" → Audio → Audio From Microphone
     */
    @input
    @hint("Audio From Microphone asset (fallback if no MicrophoneRecorder)")
    microphoneAudio: AudioTrackAsset;
    
    /** Optional: API key if your server requires it */
    @input
    apiKey: string = "est_QZV8LFmvBgq3rBfK39x22aWL_ukR4jd_cH7vBFGr4MU";
    
    /** Enable debug logging */
    @input
    debugMode: boolean = true;
    
    /** 
     * Generate test tone instead of using microphone.
     * Enable this when testing in the Lens Studio Simulator,
     * which doesn't provide real microphone audio.
     * Generates a 440Hz sine wave for testing audio streaming.
     */
    @input
    @hint("Enable for simulator testing (generates 440Hz test tone)")
    useTestTone: boolean = false;
    
    /** InternetModule for WebSocket connections (required for Lens Studio 5.9+) */
    @input
    @hint("Connect the InternetModule from your scene")
    internetModule: InternetModule;
    
    /** 
     * Audio Track asset for playing bot voice responses.
     * In Lens Studio: Asset Browser → "+" → Audio → Audio Track
     * Make sure to also add an AudioComponent to your scene to hear the audio.
     */
    @input
    @hint("Audio Track asset for voice playback")
    audioOutput: AudioTrackAsset;
    
    // ==================== Private Members ====================
    
    private character: EstuaryCharacter | null = null;
    private microphone: EstuaryMicrophone | null = null;
    private audioPlayer: EstuaryAudioPlayer | null = null;
    private playerId: string = "";
    private updateEvent: SceneEvent | null = null;
    
    // ==================== Lifecycle ====================
    
    onAwake() {
        this.log("Initializing...");
        
        // Set up InternetModule for WebSocket connections (required for Lens Studio 5.9+)
        if (this.internetModule) {
            setInternetModule(this.internetModule);
            this.log("InternetModule configured");
        } else {
            print("[SimpleAutoConnect] ERROR: InternetModule is required! Add it to your scene and connect it.");
            return;
        }
        
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
        
        // Set up audio player for voice responses
        if (this.audioOutput) {
            const outputControl = (this.audioOutput as any).control as AudioOutputControl;
            if (outputControl) {
                this.audioPlayer = new EstuaryAudioPlayer(outputControl);
                this.audioPlayer.debugLogging = this.debugMode;
                this.character.audioPlayer = this.audioPlayer;
                print("[SimpleAutoConnect] ✅ Audio player configured for voice playback");
            } else {
                print("[SimpleAutoConnect] ⚠️ WARNING: Could not get control from audioOutput asset");
            }
        } else {
            print("[SimpleAutoConnect] ⚠️ WARNING: No audioOutput configured - voice responses won't be played");
            print("[SimpleAutoConnect] Add 'Audio Track' asset: Asset Browser → '+' → Audio → Audio Track");
        }
        
        // Create microphone with immediate streaming (lowest latency)
        this.microphone = new EstuaryMicrophone(this.character);
        this.microphone.streamImmediately = true;  // Send audio as soon as received (default)
        this.microphone.useVoiceActivityDetection = false; // Backend has Deepgram VAD
        this.microphone.debugLogging = this.debugMode;
        
        // Enable test tone for simulator testing
        // The Lens Studio simulator doesn't stream real microphone audio,
        // so enable this to generate a 440Hz test tone for testing audio streaming
        if (this.useTestTone) {
            this.microphone.generateTestTone = true;
            this.log("Test tone mode enabled - will generate 440Hz sine wave");
        }
        
        // Set up microphone - prefer MicrophoneRecorder (event-based, recommended)
        if (this.microphoneRecorderObject) {
            print("[SimpleAutoConnect] microphoneRecorderObject input detected, searching for MicrophoneRecorder...");
            
            const sceneObj = this.microphoneRecorderObject;
            let micRecorder: MicrophoneRecorder | null = null;
            
            // Get all script components on the SceneObject
            const componentCount = sceneObj.getComponentCount("Component.ScriptComponent");
            print(`[SimpleAutoConnect] Found ${componentCount} ScriptComponent(s) on object`);
            
            for (let i = 0; i < componentCount; i++) {
                const scriptComp = sceneObj.getComponentByIndex("Component.ScriptComponent", i) as any;
                if (scriptComp) {
                    // Log what we find
                    print(`[SimpleAutoConnect] Script ${i}: checking for MicrophoneRecorder API...`);
                    
                    // Check if this script has onAudioFrame (MicrophoneRecorder signature)
                    if (scriptComp.onAudioFrame && typeof scriptComp.startRecording === 'function') {
                        print("[SimpleAutoConnect] ✅ Found MicrophoneRecorder directly on script component");
                        micRecorder = scriptComp as MicrophoneRecorder;
                        break;
                    }
                    
                    // Check .api property
                    if (scriptComp.api && scriptComp.api.onAudioFrame) {
                        print("[SimpleAutoConnect] ✅ Found MicrophoneRecorder via .api property");
                        micRecorder = scriptComp.api as MicrophoneRecorder;
                        break;
                    }
                    
                    // Log available properties for debugging
                    const props: string[] = [];
                    for (const key in scriptComp) {
                        props.push(key);
                    }
                    print(`[SimpleAutoConnect] Script ${i} properties: ${props.slice(0, 10).join(', ')}${props.length > 10 ? '...' : ''}`);
                }
            }
            
            if (micRecorder) {
                this.microphone.setMicrophoneRecorder(micRecorder);
                this.character.microphone = this.microphone;
                print("[SimpleAutoConnect] ✅ MicrophoneRecorder configured successfully");
            } else {
                print("[SimpleAutoConnect] ⚠️ Could not find MicrophoneRecorder API on any script component");
                print("[SimpleAutoConnect] Make sure the MicrophoneRecorder script is attached to this object");
            }
        } 
        // Fallback: Use Audio From Microphone asset (polling-based)
        else if (this.microphoneAudio) {
            // Access the audio provider from the Audio From Microphone asset
            const audioProvider = (this.microphoneAudio as any).audioProvider as MicrophoneAudioProvider;
            if (audioProvider) {
                this.microphone.setMicrophoneProvider(audioProvider);
                this.character.microphone = this.microphone;
                print("[SimpleAutoConnect] Using fallback: MicrophoneAudioProvider (polling-based)");
            } else {
                // Fallback: try accessing control property
                const control = (this.microphoneAudio as any).control;
                if (control) {
                    this.microphone.setAudioInput(control);
                    this.character.microphone = this.microphone;
                    print("[SimpleAutoConnect] Using fallback: microphoneAudio.control");
                } else {
                    print("[SimpleAutoConnect] ⚠️ WARNING: Could not get audio provider from microphoneAudio");
                }
            }
        } else {
            print("[SimpleAutoConnect] ⚠️ WARNING: No microphone input configured!");
            print("[SimpleAutoConnect] RECOMMENDED: Add MicrophoneRecorder from RemoteServiceGateway.lspkg");
            print("[SimpleAutoConnect] Alternative: Add 'Audio From Microphone' asset");
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
        if (this.audioPlayer) {
            this.audioPlayer.stopPlayback();
            this.audioPlayer = null;
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
            
            // Start voice session FIRST - this enables audio streaming
            this.character!.startVoiceSession();
            
            // Then start mic streaming
            this.startMicStream();
        });
        
        // Disconnected
        this.character.on('disconnected', () => {
            this.log("Disconnected");
            if (this.microphone) {
                this.microphone.stopRecording();
            }
        });
        
        // AI response (text)
        this.character.on('botResponse', (response: BotResponse) => {
            if (response.isFinal) {
                print(`[AI] ${response.text}`);
            }
        });
        
        // AI voice response (audio)
        this.character.on('voiceReceived', (data: any) => {
            if (this.debugMode) {
                this.log(`Voice audio received: ${data.audio?.length || 0} chars base64`);
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
        // Process microphone audio every frame (only needed for polling-based recording)
        // MicrophoneRecorder uses event-based delivery, so this is a no-op when using it
        if (this.microphone && this.microphone.isRecording) {
            // Only process if NOT using event-based MicrophoneRecorder
            if (!this.microphoneRecorderObject) {
                this.microphone.processAudioFrame(1024);
            }
        }
        
        // Process audio playback every frame
        if (this.audioPlayer) {
            this.audioPlayer.processAudioFrame();
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
