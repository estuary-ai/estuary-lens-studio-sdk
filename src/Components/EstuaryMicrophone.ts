/**
 * Microphone component for Estuary voice input in Lens Studio.
 * Captures audio from the microphone and streams it to Estuary for speech-to-text.
 * 
 * Uses MicrophoneRecorder from RemoteServiceGateway.lspkg for event-based audio capture.
 * VAD (Voice Activity Detection) is handled by the Deepgram backend.
 */

import { EstuaryCharacter, IEstuaryMicrophoneController } from './EstuaryCharacter';
import { floatToPCM16, DEFAULT_RECORD_SAMPLE_RATE } from '../Utilities/AudioConverter';
import { EventEmitter } from '../Core/EstuaryEvents';

/**
 * Event types for EstuaryMicrophone
 */
export interface EstuaryMicrophoneEvents {
    recordingStarted: () => void;
    recordingStopped: () => void;
    audioChunkSent: (chunkSize: number) => void;
}

/**
 * Interface for MicrophoneRecorder from RemoteServiceGateway.lspkg
 * This is the RECOMMENDED way to capture microphone audio in Lens Studio.
 * 
 * The MicrophoneRecorder is a SceneObject component that:
 * - Properly handles microphone permissions
 * - Uses event-based audio delivery (not polling)
 * - Works reliably in both simulator and on device
 * - Handles sample rate conversion internally
 * 
 * Usage: Add MicrophoneRecorder component to a SceneObject in your scene,
 * then pass it to setMicrophoneRecorder()
 */
export interface MicrophoneRecorder {
    /** Set the sample rate for recording */
    setSampleRate(sampleRate: number): void;
    /** Event fired when an audio frame is ready */
    onAudioFrame: {
        add(callback: (audioFrame: Float32Array) => void): void;
        remove?(callback: (audioFrame: Float32Array) => void): void;
    };
    /** Start recording */
    startRecording(): void;
    /** Stop recording */
    stopRecording(): void;
}

/**
 * EstuaryMicrophone - Handles microphone input for voice chat.
 * Implements IEstuaryMicrophoneController for use with EstuaryCharacter.
 * 
 * This simplified version only supports MicrophoneRecorder (event-based).
 * VAD is handled by the Deepgram backend, not client-side.
 */
export class EstuaryMicrophone 
    extends EventEmitter<any>
    implements IEstuaryMicrophoneController {

    // ==================== Configuration ====================

    /** Sample rate for recording (must be 16000 for Deepgram STT) */
    private _sampleRate: number = DEFAULT_RECORD_SAMPLE_RATE;

    /** Debug logging enabled */
    private _debugLogging: boolean = false;

    // ==================== State ====================

    /** Whether currently recording */
    private _isRecording: boolean = false;

    /** Frame counter for debug logging */
    private _frameCount: number = 0;

    /** Track frames that had audio vs empty frames */
    private _framesWithAudio: number = 0;

    /** Chunks sent counter */
    private _chunksSent: number = 0;

    // ==================== Throttling ====================

    /** Throttle audio sends to prevent WebSocket overflow */
    private _lastSendTime: number = 0;
    
    /** Max 10 sends per second - prevents Lens Studio WebSocket concatenation */
    private _minSendIntervalMs: number = 100;
    
    /** Buffer for accumulating throttled audio */
    private _pendingAudioBuffer: Float32Array | null = null;

    // ==================== References ====================

    /** Target character to send audio to */
    private _targetCharacter: EstuaryCharacter | null = null;

    /** MicrophoneRecorder from RemoteServiceGateway.lspkg */
    private _microphoneRecorder: MicrophoneRecorder | null = null;

    // ==================== Constructor ====================

    constructor(targetCharacter?: EstuaryCharacter) {
        super();
        if (targetCharacter) {
            this._targetCharacter = targetCharacter;
        }
    }

    // ==================== Properties ====================

    get sampleRate(): number {
        return this._sampleRate;
    }

    set sampleRate(value: number) {
        this._sampleRate = value;
    }

    get debugLogging(): boolean {
        return this._debugLogging;
    }

    set debugLogging(value: boolean) {
        this._debugLogging = value;
    }

    get isRecording(): boolean {
        return this._isRecording;
    }

    get targetCharacter(): EstuaryCharacter | null {
        return this._targetCharacter;
    }

    set targetCharacter(character: EstuaryCharacter | null) {
        this._targetCharacter = character;
    }

    // ==================== Public Methods ====================

    /**
     * Set the MicrophoneRecorder from RemoteServiceGateway.lspkg
     * 
     * The MicrophoneRecorder component provides event-based audio delivery which
     * works reliably in both the simulator and on real hardware.
     * 
     * @param recorder The MicrophoneRecorder component from your scene
     */
    setMicrophoneRecorder(recorder: MicrophoneRecorder): void {
        this._microphoneRecorder = recorder;
        
        print('[EstuaryMicrophone] ========================================');
        print('[EstuaryMicrophone] Setting up MicrophoneRecorder...');
        
        // Set sample rate to match Deepgram requirements
        if (typeof recorder.setSampleRate === 'function') {
            recorder.setSampleRate(this._sampleRate);
            print(`[EstuaryMicrophone] Set sample rate to ${this._sampleRate}Hz`);
        } else {
            print(`[EstuaryMicrophone] ⚠️ setSampleRate not available, using default`);
        }
        
        // Subscribe to audio frame events
        if (recorder.onAudioFrame && typeof recorder.onAudioFrame.add === 'function') {
            recorder.onAudioFrame.add((audioFrame: Float32Array) => {
                this.handleAudioFrame(audioFrame);
            });
            print('[EstuaryMicrophone] ✅ Subscribed to onAudioFrame events');
        } else {
            print('[EstuaryMicrophone] ❌ ERROR: onAudioFrame.add not available!');
            return;
        }
        
        print('[EstuaryMicrophone] ✅ MicrophoneRecorder configured');
        print('[EstuaryMicrophone] ========================================');
    }

    /**
     * Start recording from the microphone.
     */
    startRecording(): void {
        if (this._isRecording) {
            this.log('Already recording');
            return;
        }

        if (!this._microphoneRecorder) {
            print('[EstuaryMicrophone] ❌ ERROR: MicrophoneRecorder not set! Call setMicrophoneRecorder() first.');
            return;
        }

        this._isRecording = true;
        this._chunksSent = 0;
        this._frameCount = 0;
        this._framesWithAudio = 0;
        this._pendingAudioBuffer = null;
        
        this._microphoneRecorder.startRecording();
        print('[EstuaryMicrophone] ✅ Started recording');
        this.emit('recordingStarted');
    }

    /**
     * Stop recording from the microphone.
     */
    stopRecording(): void {
        if (!this._isRecording) {
            return;
        }

        if (this._microphoneRecorder) {
            this._microphoneRecorder.stopRecording();
        }
        
        this._isRecording = false;
        
        // Log final stats
        if (this._chunksSent > 0) {
            print(`[EstuaryMicrophone] Recording stats: sent=${this._chunksSent}, frames=${this._frameCount}, withAudio=${this._framesWithAudio}`);
        }
        
        print('[EstuaryMicrophone] Stopped recording');
        this.emit('recordingStopped');
    }

    /**
     * Toggle recording on/off.
     */
    toggleRecording(): void {
        if (this._isRecording) {
            this.stopRecording();
        } else {
            this.startRecording();
        }
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        this.stopRecording();
        this._microphoneRecorder = null;
        this._targetCharacter = null;
        this._pendingAudioBuffer = null;
        this.removeAllListeners();
    }

    // ==================== Private Methods ====================

    /**
     * Handle audio frame from MicrophoneRecorder event.
     */
    private handleAudioFrame(audioFrame: Float32Array): void {
        if (!this._isRecording) {
            return;
        }
        
        this._frameCount++;
        
        if (audioFrame && audioFrame.length > 0) {
            this._framesWithAudio++;
            
            // Debug logging every 100 frames
            if (this._debugLogging && this._frameCount % 100 === 0) {
                print(`[EstuaryMicrophone] Frame ${this._frameCount}: ${audioFrame.length} samples`);
            }
            
            // Send audio to backend
            this.sendAudioToBackend(audioFrame);
        }
    }

    /**
     * Send audio to the backend with throttling and Base64 encoding.
     * Uses native Lens Studio Base64 class for hardware compatibility.
     */
    private sendAudioToBackend(samples: Float32Array): void {
        if (!this._targetCharacter || !this._targetCharacter.isConnected) {
            if (this._debugLogging && this._chunksSent === 0) {
                print(`[EstuaryMicrophone] Not connected, skipping audio chunk`);
            }
            return;
        }

        // Throttle sends to prevent WebSocket buffer overflow
        const now = Date.now();
        const timeSinceLastSend = now - this._lastSendTime;
        
        if (timeSinceLastSend < this._minSendIntervalMs) {
            // Too soon - accumulate audio in pending buffer
            if (!this._pendingAudioBuffer) {
                this._pendingAudioBuffer = new Float32Array(samples);
            } else {
                // Append to pending buffer
                const combined = new Float32Array(this._pendingAudioBuffer.length + samples.length);
                combined.set(this._pendingAudioBuffer);
                combined.set(samples, this._pendingAudioBuffer.length);
                this._pendingAudioBuffer = combined;
            }
            return;
        }
        
        // Include any pending audio
        let finalAudio = samples;
        if (this._pendingAudioBuffer) {
            const combined = new Float32Array(this._pendingAudioBuffer.length + samples.length);
            combined.set(this._pendingAudioBuffer);
            combined.set(samples, this._pendingAudioBuffer.length);
            finalAudio = combined;
            this._pendingAudioBuffer = null;
        }
        
        // Convert to Base64 PCM16 using native Lens Studio Base64
        const pcmBytes = floatToPCM16(finalAudio);
        const base64Audio = Base64.encode(pcmBytes);
        
        this._chunksSent++;
        this._lastSendTime = now;
        
        // Log first chunk to confirm audio is being sent
        if (this._chunksSent === 1) {
            print(`[EstuaryMicrophone] ✅ First audio chunk sent: ${finalAudio.length} samples @ ${this._sampleRate}Hz, base64 length=${base64Audio.length}`);
        }
        
        // Log every 20 chunks
        if (this._debugLogging && this._chunksSent % 20 === 0) {
            print(`[EstuaryMicrophone] Stats: sent=${this._chunksSent}, frames=${this._frameCount}`);
        }

        // Send to character
        this._targetCharacter.streamAudio(base64Audio);
        this.emit('audioChunkSent', finalAudio.length);
    }

    private log(message: string): void {
        if (this._debugLogging) {
            print(`[EstuaryMicrophone] ${message}`);
        }
    }
}

/**
 * Create an EstuaryMicrophone for use with Lens Studio.
 * 
 * Example usage:
 * ```typescript
 * @component
 * export class MyScript extends BaseScriptComponent {
 *     @input microphoneRecorderObject: SceneObject;
 *     
 *     private microphone: EstuaryMicrophone;
 *     private character: EstuaryCharacter;
 *     
 *     onAwake() {
 *         this.microphone = new EstuaryMicrophone(this.character);
 *         
 *         // Find MicrophoneRecorder on the SceneObject
 *         const recorder = this.microphoneRecorderObject.getComponent("...");
 *         this.microphone.setMicrophoneRecorder(recorder);
 *     }
 * }
 * ```
 */
export function createMicrophone(targetCharacter: EstuaryCharacter): EstuaryMicrophone {
    return new EstuaryMicrophone(targetCharacter);
}
