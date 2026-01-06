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

    @input
    @hint("Generated from your Estuary dashboard")
    apiKey: string = "[ESTUARY_API_KEY]";
    
    /** Your Estuary server URL */
    serverUrl: string = "wss://api.estuary-ai.com";
    
    /** The character/agent ID to connect to */
    @input
    @hint("Character/Agent ID from your Estuary dashboard")
    characterId: string = "[ESTUARY_CHARACTER_ID]";
    
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
     * ElevenLabs uses 24000Hz, other TTS providers may vary.
     */
    audioSampleRate: number = 24000;

    /** Enable debug logging */
    @input
    debugMode: boolean = true;
    
    // ==================== Private Members ====================
    
    private character: EstuaryCharacter | null = null;
    private microphone: EstuaryMicrophone | null = null;
    private dynamicAudioOutput: DynamicAudioOutput | null = null;
    private playerId: string = "";
    private updateEvent: SceneEvent | null = null;
    private audioInitialized: boolean = false;
    
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
                print(`[SimpleAutoConnect] ✅ DynamicAudioOutput configured (${this.audioSampleRate}Hz)`);
            } else {
                print("[SimpleAutoConnect] ⚠️ WARNING: Could not find DynamicAudioOutput script on object");
                print("[SimpleAutoConnect] Make sure the DynamicAudioOutput script is attached");
            }
        } else {
            print("[SimpleAutoConnect] ⚠️ WARNING: No dynamicAudioOutputObject configured - voice responses won't be played");
            print("[SimpleAutoConnect] Add DynamicAudioOutput script to a SceneObject and connect it");
        }
        
        // Create microphone (VAD is handled by Deepgram backend)
        this.microphone = new EstuaryMicrophone(this.character);
        this.microphone.debugLogging = this.debugMode;
        
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
                print("[SimpleAutoConnect] ❌ ERROR: Could not find MicrophoneRecorder API on any script component");
                print("[SimpleAutoConnect] Make sure the MicrophoneRecorder script is attached to this object");
            }
        } else {
            print("[SimpleAutoConnect] ❌ ERROR: No microphoneRecorderObject configured!");
            print("[SimpleAutoConnect] Add MicrophoneRecorder from RemoteServiceGateway.lspkg to your scene");
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
        
        // AI voice response (audio) - play using DynamicAudioOutput
        this.character.on('voiceReceived', (voice: BotVoice) => {
            if (this.debugMode) {
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
            if (this.dynamicAudioOutput) {
                this.dynamicAudioOutput.interruptAudioOutput();
                this.log("Audio interrupted");
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
        // MicrophoneRecorder uses event-based delivery, no per-frame processing needed
        // DynamicAudioOutput handles audio playback internally via native AudioComponent
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
