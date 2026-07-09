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
    @hint("SceneObject with MicrophoneRecorder script (used when micAudioTrack is NOT set)")
    microphoneRecorderObject: SceneObject;

    /**
     * OPTIONAL: Direct mic AudioTrackAsset (e.g. EstuaryAudioInput.micaudio).
     * When set, the SDK bypasses RemoteServiceGateway's MicrophoneRecorder
     * entirely and drives the MicrophoneAudioProvider itself. This is a
     * diagnostic path for testing whether the ~22% empty-frame rate we
     * observed on Spectacles is coming from RSG's wrapper or from the
     * platform. Leave this unset to use the normal RSG path.
     */
    @input
    @hint("OPTIONAL: direct-mic AudioTrackAsset (bypasses RSG — diagnostic)")
    @allowUndefined
    micAudioTrack: AudioTrackAsset;
    
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
     * 24000Hz matches Snap's official Spectacles examples.
     * Mic input remains 16kHz (hardware-locked).
     */
    audioSampleRate: number = 24000;

    
    // ==================== Private Members ====================
    
    private character: EstuaryCharacter | null = null;
    private microphone: EstuaryMicrophone | null = null;
    private actionManager: EstuaryActionManager | null = null;
    private dynamicAudioOutput: DynamicAudioOutput | null = null;
    private audioComponent: AudioComponent | null = null;
    private _outputVolume: number = 1.0;
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

    /**
     * Voice released by the server (voice_timeout) while the socket stayed
     * connected — the auto-mute illusion state. Resume via tap or unmute.
     */
    private voiceSuspended: boolean = false;

    /**
     * Session ended by the server (session_timeout) — disconnected, and
     * deliberately NOT auto-reconnected. Resume via tap or reconnect().
     */
    private sessionEnded: boolean = false;

    // ==================== Tick-Cost Diagnostics ====================
    /** Rolling sum of total onUpdate execution time (ms). Reset per print window. */
    private _diagOnUpdateSumMs: number = 0;
    /** Max single-tick total onUpdate execution time (ms) in current window. */
    private _diagOnUpdateMaxMs: number = 0;
    /** Number of onUpdate invocations in current window. */
    private _diagOnUpdateCount: number = 0;
    /** Rolling sum of time spent in microphone.pullAudioFrames. */
    private _diagPullAudioSumMs: number = 0;
    private _diagPullAudioMaxMs: number = 0;
    /** Rolling sum of time spent in tick()/processSendQueue. */
    private _diagTickInnerSumMs: number = 0;
    private _diagTickInnerMaxMs: number = 0;
    /** Rolling sum of time spent in the voiceReceived listener (outside the tick). */
    private _diagBotVoiceSumMs: number = 0;
    private _diagBotVoiceMaxMs: number = 0;
    private _diagBotVoiceCount: number = 0;
    /** Rolling sum of just the Base64.decode step inside the voiceReceived listener. */
    private _diagB64DecodeSumMs: number = 0;
    private _diagB64DecodeMaxMs: number = 0;
    /** Rolling sum of just the addAudioFrame step inside the voiceReceived listener. */
    private _diagAddFrameSumMs: number = 0;
    private _diagAddFrameMaxMs: number = 0;
    /** Last wall-clock time we printed the tick-cost stats line. */
    private _diagTickCostLastPrintMs: number = 0;
    
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
            EstuaryManager.instance.internetModule = this.internetModule;
            this.log("InternetModule configured via EstuaryManager");
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

        // Tap to resume after a server reap — user intent is the resume
        // signal per SDK_CONTRACT.md. voice_timeout → fresh voice session;
        // session_timeout → explicit reconnect. (Editor preview: click the
        // Preview panel.)
        const tapEvent = this.createEvent("TapEvent");
        tapEvent.bind(() => {
            if (this.sessionEnded) {
                this.reconnect();
            } else if (this.voiceSuspended) {
                this.resumeVoice();
            }
        });
        
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

    /**
     * Switch to a different character. Disconnects current, reconnects with new ID.
     * Used by the gallery to switch characters without destroying the SceneObject.
     */
    public switchCharacter(characterId: string): void {
        if (!this.credentials) {
            print("[EstuaryVoiceConnection] ERROR: No credentials for switchCharacter");
            return;
        }

        this.log("Switching to character: " + characterId);

        // Tear down old connection (mic, audio, action manager, character)
        this.disconnect();

        // Update credentials
        this.credentials.characterId = characterId;

        // Reconnect with the new character ID
        // (reuses existing credentials, InternetModule, playerId from onAwake)
        this.connect();
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
        // Each step wrapped individually — a crash in one shouldn't prevent cleanup of others
        if (this.microphone) {
            try {
                this.microphone.stopRecording();
                // Don't call dispose() — it nulls _microphoneRecorder and the
                // onAudioFrame subscription is never cleaned up on the hardware recorder.
            } catch (e: any) {
                print('[EstuaryVoiceConnection] Mic cleanup error: ' + (e.message || e));
            }
            this.microphone = null;
        }
        if (this.actionManager) {
            try {
                this.actionManager.dispose();
            } catch (e: any) {
                print('[EstuaryVoiceConnection] ActionManager cleanup error: ' + (e.message || e));
            }
            this.actionManager = null;
        }
        // Disconnect character BEFORE interrupting audio —
        // stops the WebSocket from feeding new audio chunks during teardown
        if (this.character) {
            try {
                this.character.dispose();
            } catch (e: any) {
                print('[EstuaryVoiceConnection] Character dispose error: ' + (e.message || e));
            }
            this.character = null;
        }
        // Interrupt audio but DON'T null — dynamicAudioOutput is a persistent hardware
        // component that gets double-initialized if re-discovered, causing crash on 2nd switch
        if (this.dynamicAudioOutput) {
            try {
                this.dynamicAudioOutput.interruptAudioOutput();
            } catch (e: any) {
                print('[EstuaryVoiceConnection] Audio interrupt error: ' + (e.message || e));
            }
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
            this.voiceSuspended = false;
            this.sessionEnded = false;
            
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

        // Server released voice after inactivity (voice_timeout) — the SDK
        // already stopped the mic and cleared voice state; the socket (and
        // text chat) stay live. Present it as an auto-muted mic.
        this.character.on('voiceTimeout', (data: any) => {
            this.voiceSuspended = true;
            const idle = data?.idle_seconds ?? '?';
            print(`[EstuaryVoiceConnection] 🎙️ Voice auto-muted by server after ${idle}s without speech — tap (or unmute) to resume; text still works`);
        });

        // Server ended the whole session for inactivity (session_timeout) —
        // a disconnect follows, and no SDK layer will auto-reconnect (that
        // would re-establish billed resources in a loop). Resume on intent.
        this.character.on('sessionTimeout', (data: any) => {
            this.sessionEnded = true;
            const idle = data?.idle_seconds ?? '?';
            print(`[EstuaryVoiceConnection] ⏱️ Session ended by server after ${idle}s of inactivity — tap (or call reconnect()) to resume`);
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
            const tListenerStart = Date.now();
            // Record activity - voice response received
            this.recordActivity();

            if (this.credentials?.debugMode) {
                this.log(`Voice audio received: ${voice.audio?.length || 0} chars base64, chunk ${voice.chunkIndex}`);
            }

            // Play audio using DynamicAudioOutput (hardware-compatible)
            if (this.dynamicAudioOutput && voice.audio && voice.audio.length > 0) {
                // Decode base64 to PCM16 bytes using native Lens Studio Base64
                const tDecodeStart = Date.now();
                const pcmBytes = Base64.decode(voice.audio);
                const decodeMs = Date.now() - tDecodeStart;

                const tAddStart = Date.now();
                this.dynamicAudioOutput.addAudioFrame(pcmBytes, 1);
                const addMs = Date.now() - tAddStart;

                // Rolling stats — a suspiciously-long addMs here is our smoking gun
                // for the native ring-buffer-back-pressure hypothesis.
                this._diagB64DecodeSumMs += decodeMs;
                if (decodeMs > this._diagB64DecodeMaxMs) this._diagB64DecodeMaxMs = decodeMs;
                this._diagAddFrameSumMs += addMs;
                if (addMs > this._diagAddFrameMaxMs) this._diagAddFrameMaxMs = addMs;
            }

            const listenerMs = Date.now() - tListenerStart;
            this._diagBotVoiceSumMs += listenerMs;
            if (listenerMs > this._diagBotVoiceMaxMs) this._diagBotVoiceMaxMs = listenerMs;
            this._diagBotVoiceCount++;
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
    /** Cached MicrophoneRecorder hardware reference (persistent across connections) */
    private _cachedMicRecorder: MicrophoneRecorder | null = null;

    private discoverHardwareComponents(): void {
        // Audio output: persistent hardware, discover once
        if (!this.dynamicAudioOutput) {
            this.discoverDynamicAudioOutput();
        }
        // Mic: full discovery on first connect, reuse cached recorder on reconnect.
        // setMicrophoneRecorder adds an onAudioFrame listener each time, but old
        // listeners are harmless — the old mic has _isRecording=false so handleAudioFrame
        // returns immediately. Only the current mic processes frames.
        if (this.microphone && !this.microphone.isRecording) {
            if (this.micAudioTrack) {
                // Direct-mic diagnostic path — bypass RSG's MicrophoneRecorder
                print('[EstuaryDiag] Using DIRECT mic path (micAudioTrack is set)');
                this.microphone.setAudioTrackAsset(this.micAudioTrack);
                this.character!.microphone = this.microphone;
            } else if (!this._cachedMicRecorder) {
                this.discoverMicrophoneRecorder();
                this._cachedMicRecorder = (this.microphone as any)._microphoneRecorder || null;
            } else {
                this.microphone.setMicrophoneRecorder(this._cachedMicRecorder);
                this.character!.microphone = this.microphone;
                this.log('Reconnected mic to cached MicrophoneRecorder');
            }
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
                this.audioComponent = audioComp as AudioComponent;

                // mixToSnap MUST be true for LowLatency playbackMode to actually stick.
                // Per Spectacles audio docs, LowLatency is silently downgraded to
                // LowPower if any AudioComponent in the scene has mixToSnap=false.
                // Set it before the playbackMode so the change is coherent.
                const mixToSnapBefore = (this.audioComponent as any).mixToSnap;
                try {
                    (this.audioComponent as any).mixToSnap = true;
                } catch (e) {
                    print('[EstuaryDiag] mixToSnap assignment threw: ' + e);
                }
                const mixToSnapAfter = (this.audioComponent as any).mixToSnap;
                print(
                    `[EstuaryDiag] PLAYBACK mixToSnap before=${mixToSnapBefore} after=${mixToSnapAfter}`
                );

                this.audioComponent.playbackMode = Audio.PlaybackMode.LowLatency;
                this.audioComponent.volume = this._outputVolume;
                this.log("AudioComponent set to Low Latency mode");

                // ---- DIAGNOSTIC: verify low-latency mode actually stuck ----
                // Spectacles docs say LowLatency is only honored if ALL audio
                // components in the scene use mix-to-snap. Any mixToSnap=false
                // elsewhere silently downgrades playback to LowPower mode,
                // which "introduces latency in audio playback."
                try {
                    const mode = (this.audioComponent as any).playbackMode;
                    const mixToSnap = (this.audioComponent as any).mixToSnap;
                    const expected = Audio.PlaybackMode.LowLatency;
                    print(
                        `[EstuaryDiag] PLAYBACK playbackMode_after_set=${mode} ` +
                        `expected=${expected} match=${mode === expected} ` +
                        `mixToSnap=${mixToSnap}`
                    );
                    if (mode !== expected) {
                        print(
                            `[EstuaryDiag] ⚠️ playbackMode did NOT stick — Spectacles ` +
                            `may be ignoring LowLatency request (check other AudioComponents' mixToSnap).`
                        );
                    }
                } catch (e) {
                    print('[EstuaryDiag] playbackMode readback threw: ' + e);
                }

                // ---- DIAGNOSTIC: probe AudioOutputProvider preferred frame size ----
                // RSG's DynamicAudioOutput holds a private audioOutputProvider.
                // getPreferredFrameSize() returns the buffer size the system
                // prefers before starting playback. If TTS chunks are much
                // smaller than this, the player stalls priming its buffer on
                // every turn — that's perceived as "AI takes forever to start
                // talking after I finish."
                try {
                    const provider = (this.dynamicAudioOutput as any).audioOutputProvider;
                    if (provider) {
                        const sampleRate = provider.sampleRate;
                        let preferred = 'n/a';
                        if (typeof provider.getPreferredFrameSize === 'function') {
                            preferred = String(provider.getPreferredFrameSize());
                        }
                        print(
                            `[EstuaryDiag] PLAYBACK provider sampleRate=${sampleRate} ` +
                            `preferredFrameSize=${preferred}`
                        );
                    } else {
                        print('[EstuaryDiag] PLAYBACK provider introspection unavailable (no .audioOutputProvider field)');
                    }
                } catch (e) {
                    print('[EstuaryDiag] PLAYBACK provider probe threw: ' + e);
                }
            } else {
                print('[EstuaryDiag] ⚠️ No AudioComponent found on dynamicAudioOutputObject — cannot set LowLatency');
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
        const tOnUpdateStart = Date.now();

        // MicrophoneRecorder (RSG path) uses event-based delivery, no per-frame pull needed.
        // DynamicAudioOutput handles audio playback internally via native AudioComponent.
        // Direct-mic path (when micAudioTrack is set) requires us to pull frames each tick.
        if (this.microphone && this.micAudioTrack) {
            const tPull = Date.now();
            this.microphone.pullAudioFrames();
            const pullMs = Date.now() - tPull;
            this._diagPullAudioSumMs += pullMs;
            if (pullMs > this._diagPullAudioMaxMs) this._diagPullAudioMaxMs = pullMs;
        }

        // Check for inactivity timeout and process send queue
        const tTick = Date.now();
        this.checkInactivityAndTick();
        const tickMs = Date.now() - tTick;
        this._diagTickInnerSumMs += tickMs;
        if (tickMs > this._diagTickInnerMaxMs) this._diagTickInnerMaxMs = tickMs;

        const onUpdateMs = Date.now() - tOnUpdateStart;
        this._diagOnUpdateSumMs += onUpdateMs;
        if (onUpdateMs > this._diagOnUpdateMaxMs) this._diagOnUpdateMaxMs = onUpdateMs;
        this._diagOnUpdateCount++;

        // Print a breakdown every ~1s so we can see exactly where the budget goes.
        const now = Date.now();
        if (this._diagTickCostLastPrintMs === 0) {
            this._diagTickCostLastPrintMs = now;
        } else if (now - this._diagTickCostLastPrintMs >= 1000) {
            this.printTickCostStats();
            this._diagTickCostLastPrintMs = now;
        }
    }

    private printTickCostStats(): void {
        if (this._diagOnUpdateCount === 0) return;
        const avgOnUpdate = (this._diagOnUpdateSumMs / this._diagOnUpdateCount).toFixed(1);
        const avgPull = (this._diagPullAudioSumMs / this._diagOnUpdateCount).toFixed(1);
        const avgTick = (this._diagTickInnerSumMs / this._diagOnUpdateCount).toFixed(1);
        const voiceCount = this._diagBotVoiceCount;
        const avgVoice = voiceCount > 0 ? (this._diagBotVoiceSumMs / voiceCount).toFixed(1) : '-';
        const avgDecode = voiceCount > 0 ? (this._diagB64DecodeSumMs / voiceCount).toFixed(1) : '-';
        const avgAdd = voiceCount > 0 ? (this._diagAddFrameSumMs / voiceCount).toFixed(1) : '-';

        print(
            `[EstuaryDiag] TICKCOST ticks=${this._diagOnUpdateCount} ` +
            `onUpdate=${avgOnUpdate}ms max=${this._diagOnUpdateMaxMs} ` +
            `pullAudio=${avgPull}ms max=${this._diagPullAudioMaxMs} ` +
            `tickInner=${avgTick}ms max=${this._diagTickInnerMaxMs} | ` +
            `voiceRx=${voiceCount} total=${this._diagBotVoiceSumMs}ms avg=${avgVoice}ms ` +
            `max=${this._diagBotVoiceMaxMs} decode_avg=${avgDecode}ms decode_max=${this._diagB64DecodeMaxMs} ` +
            `addFrame_avg=${avgAdd}ms addFrame_max=${this._diagAddFrameMaxMs}`
        );

        // Reset rolling counters so each print shows the last ~1s window.
        this._diagOnUpdateSumMs = 0;
        this._diagOnUpdateMaxMs = 0;
        this._diagOnUpdateCount = 0;
        this._diagPullAudioSumMs = 0;
        this._diagPullAudioMaxMs = 0;
        this._diagTickInnerSumMs = 0;
        this._diagTickInnerMaxMs = 0;
        this._diagBotVoiceSumMs = 0;
        this._diagBotVoiceMaxMs = 0;
        this._diagBotVoiceCount = 0;
        this._diagB64DecodeSumMs = 0;
        this._diagB64DecodeMaxMs = 0;
        this._diagAddFrameSumMs = 0;
        this._diagAddFrameMaxMs = 0;
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
    
    /** Output volume for bot audio (0.0 = muted, 1.0 = full). Clamped to 0-1. */
    get outputVolume(): number {
        return this._outputVolume;
    }

    set outputVolume(value: number) {
        this._outputVolume = Math.max(0, Math.min(1, value));
        if (this.audioComponent) {
            this.audioComponent.volume = this._outputVolume;
        }
        this.log(`Output volume set to ${this._outputVolume.toFixed(2)}`);
    }

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
        // Unmuting after a server voice release (voice_timeout) must start a
        // FRESH voice session — just restarting the mic would stream audio
        // into a closed STT stream (the auto-mute illusion's unmute path).
        if (this.voiceSuspended) {
            this.resumeVoice();
            return this.isMuted;
        }
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
        if (!muted && this.voiceSuspended) {
            // Unmute after a server voice release = start a fresh voice session
            this.resumeVoice();
            return;
        }
        if (!this.microphone) return;
        if (muted && this.microphone.isRecording) {
            this.microphone.stopRecording();
        } else if (!muted && !this.microphone.isRecording) {
            this.microphone.startRecording();
        }
    }

    /**
     * Resume voice after a server voice_timeout. Starts a fresh voice
     * session (the gateway restarts STT on demand) and the mic with it.
     */
    resumeVoice(): void {
        if (!this.character?.isConnected) {
            print("[EstuaryVoiceConnection] Cannot resume voice: not connected — use reconnect()");
            return;
        }
        this.voiceSuspended = false;
        this.recordActivity();
        this.character.startVoiceSession();
        print("[EstuaryVoiceConnection] 🎙️ Voice resumed after server release");
    }

    /**
     * Explicitly reconnect after a server session_timeout (or any other
     * disconnect). This is the user-intent resume path — nothing reconnects
     * automatically after an idle reap.
     */
    reconnect(): void {
        if (this.character?.isConnected) {
            this.log("reconnect() ignored: already connected");
            return;
        }
        print("[EstuaryVoiceConnection] Reconnecting on user intent...");
        this.sessionEnded = false;
        this.voiceSuspended = false;
        this.recordActivity();
        // Fresh character/mic instances; the 'connected' handler restarts
        // voice + mic streaming (same path as switchCharacter)
        this.disconnect();
        this.connect();
    }

    // ==================== Utility ====================
    
    private log(message: string): void {
        if (this.credentials?.debugMode) {
            print(`[EstuaryVoiceConnection] ${message}`);
        }
    }
}
