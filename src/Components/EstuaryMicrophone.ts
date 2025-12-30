
/**
 * Microphone component for Estuary voice input in Lens Studio.
 * Captures audio from the microphone and streams it to Estuary for speech-to-text.
 * 
 * Lens Studio provides multiple options for audio input:
 * 1. VoiceML - Built-in speech recognition (uses Snap's STT)
 * 2. AudioInput - Raw audio access (requires extended permissions)
 * 
 * This implementation supports both approaches.
 */

import { EstuaryCharacter, IEstuaryMicrophoneController } from './EstuaryCharacter';
import { encodeAudio } from '../Utilities/Base64Helper';
import { calculateRMS, resample, DEFAULT_RECORD_SAMPLE_RATE } from '../Utilities/AudioConverter';
import { EventEmitter } from '../Core/EstuaryEvents';

/**
 * Event types for EstuaryMicrophone
 */
export interface EstuaryMicrophoneEvents {
    recordingStarted: () => void;
    recordingStopped: () => void;
    volumeChanged: (volume: number) => void;
    speechDetected: () => void;
    silenceDetected: () => void;
    audioChunkSent: (chunkSize: number) => void;
}

/**
 * Interface for Lens Studio's MicrophoneAudioProvider.
 * This is the correct API for accessing raw microphone PCM data.
 * 
 * According to Lens Studio documentation:
 * - Use MicrophoneAudioProvider.getAudioFrame() to access raw PCM audio
 * - Returns a Float32Array with audio samples
 */
export interface MicrophoneAudioProvider {
    /** Get raw audio frame data as Float32Array */
    getAudioFrame(buffer: Float32Array): number | Float32Array;
    /** Sample rate of the microphone input */
    sampleRate?: number;
    /** Start the audio provider */
    start?(): void;
    /** Stop the audio provider */
    stop?(): void;
}

/**
 * Interface for MicrophoneRecorder from RemoteServiceGateway.lspkg
 * This is the RECOMMENDED way to capture microphone audio in Lens Studio.
 * 
 * The MicrophoneRecorder is a SceneObject component that:
 * - Properly handles microphone permissions
 * - Uses event-based audio delivery (not polling)
 * - Works reliably in both simulator and on device
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
 * @deprecated Use MicrophoneRecorder or MicrophoneAudioProvider instead
 * Kept for backwards compatibility
 */
export type AudioInputControl = MicrophoneAudioProvider | any;

/**
 * Interface for VoiceML transcription options
 */
export interface VoiceMLOptions {
    /** Enable continuous listening */
    continuous: boolean;
    /** Language code (e.g., 'en-US') */
    language: string;
}

/**
 * EstuaryMicrophone - Handles microphone input for voice chat.
 * Implements IEstuaryMicrophoneController for use with EstuaryCharacter.
 */
export class EstuaryMicrophone 
    extends EventEmitter<any>
    implements IEstuaryMicrophoneController {

    // ==================== Configuration ====================

    /** Sample rate for recording (must be 16000 for STT) */
    private _sampleRate: number = DEFAULT_RECORD_SAMPLE_RATE;

    /** Duration of each audio chunk in milliseconds.
     * Reduced to 40ms to keep WebSocket messages under 2KB to avoid
     * buffer overflow issues in Lens Studio's WebSocket implementation.
     */
    private _chunkDurationMs: number = 40;

    /** Volume threshold for voice activity detection (0-1) */
    private _vadThreshold: number = 0.02;

    /** Enable voice activity detection */
    private _useVoiceActivityDetection: boolean = false;

    /** Debug logging enabled */
    private _debugLogging: boolean = false;

    /** Stream audio immediately as received, without buffering.
     * When true (default), audio is sent to the backend as soon as it's read
     * from the device, enabling low-latency streaming to Deepgram.
     * When false, audio is buffered until chunkDurationMs worth of samples
     * are collected before sending.
     */
    private _streamImmediately: boolean = true;

    // ==================== State ====================

    /** Whether currently recording */
    private _isRecording: boolean = false;

    /** Current audio volume level (0-1) */
    private _currentVolume: number = 0;

    /** Whether speech is currently detected (VAD mode) */
    private _isSpeechDetected: boolean = false;

    /** Was speaking in the previous frame */
    private _wasSpeaking: boolean = false;

    // ==================== References ====================

    /** Target character to send audio to */
    private _targetCharacter: EstuaryCharacter | null = null;

    /** Audio input control from Lens Studio */
    private _audioInput: AudioInputControl | null = null;

    /** Buffer for accumulating audio samples */
    private _sampleBuffer: Float32Array | null = null;

    /** Current position in sample buffer */
    private _bufferPosition: number = 0;

    /** Frame counter for debug logging */
    private _frameCount: number = 0;

    /** Track frames that had audio vs empty frames */
    private _framesWithAudio: number = 0;
    private _framesWithoutAudio: number = 0;

    /** Track consecutive empty frames to detect simulator mode */
    private _consecutiveEmptyFrames: number = 0;
    private _simulatorModeWarned: boolean = false;

    /** Enable test tone generation for simulator testing */
    private _generateTestTone: boolean = false;
    private _testTonePhase: number = 0;

    /** Throttle audio sends to prevent WebSocket overflow */
    private _lastSendTime: number = 0;
    private _minSendIntervalMs: number = 100; // Max 10 sends per second - prevents Lens Studio WebSocket concatenation
    private _pendingAudioBuffer: Float32Array | null = null;

    /** MicrophoneRecorder from RemoteServiceGateway.lspkg (recommended) */
    private _microphoneRecorder: MicrophoneRecorder | null = null;
    
    /** Whether using event-based MicrophoneRecorder (vs polling) */
    private _useEventBasedRecording: boolean = false;

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
        this.updateSampleBuffer();
    }

    get chunkDurationMs(): number {
        return this._chunkDurationMs;
    }

    set chunkDurationMs(value: number) {
        this._chunkDurationMs = value;
        this.updateSampleBuffer();
    }

    get vadThreshold(): number {
        return this._vadThreshold;
    }

    set vadThreshold(value: number) {
        this._vadThreshold = Math.max(0, Math.min(1, value));
    }

    get useVoiceActivityDetection(): boolean {
        return this._useVoiceActivityDetection;
    }

    set useVoiceActivityDetection(value: boolean) {
        this._useVoiceActivityDetection = value;
    }

    get debugLogging(): boolean {
        return this._debugLogging;
    }

    set debugLogging(value: boolean) {
        this._debugLogging = value;
    }

    /** Whether to stream audio immediately without buffering (default: true) */
    get streamImmediately(): boolean {
        return this._streamImmediately;
    }

    set streamImmediately(value: boolean) {
        this._streamImmediately = value;
    }

    /** 
     * Enable test tone generation for simulator testing.
     * When true, generates a synthetic 440Hz sine wave instead of using
     * microphone input. Use this to test audio streaming when the Lens Studio
     * simulator doesn't provide real microphone data.
     */
    get generateTestTone(): boolean {
        return this._generateTestTone;
    }

    set generateTestTone(value: boolean) {
        this._generateTestTone = value;
        if (value) {
            print('[EstuaryMicrophone] Test tone mode ENABLED - will generate 440Hz sine wave');
        }
    }

    get isRecording(): boolean {
        return this._isRecording;
    }

    get currentVolume(): number {
        return this._currentVolume;
    }

    get isSpeechDetected(): boolean {
        return this._isSpeechDetected;
    }

    get targetCharacter(): EstuaryCharacter | null {
        return this._targetCharacter;
    }

    set targetCharacter(character: EstuaryCharacter | null) {
        this._targetCharacter = character;
    }

    // ==================== Public Methods ====================

    /**
     * Set the MicrophoneAudioProvider from Lens Studio.
     * 
     * To get the MicrophoneAudioProvider:
     * 1. Add an "Audio From Microphone" asset in Lens Studio
     * 2. Get its audioProvider property (not .control)
     * 
     * @param audioInput The MicrophoneAudioProvider instance
     */
    /** Actual sample rate of the audio input device */
    private _inputSampleRate: number = 16000;

    setAudioInput(audioInput: MicrophoneAudioProvider | AudioInputControl): void {
        this._audioInput = audioInput;
        
        // Log available methods and properties for debugging
        if (audioInput) {
            const methods: string[] = [];
            const props: string[] = [];
            for (const key in audioInput) {
                if (typeof audioInput[key] === 'function') {
                    methods.push(key);
                } else {
                    props.push(`${key}=${audioInput[key]}`);
                }
            }
            print(`[EstuaryMicrophone] ========================================`);
            print(`[EstuaryMicrophone] MicrophoneAudioProvider detected`);
            print(`[EstuaryMicrophone] Available methods: ${methods.join(', ')}`);
            print(`[EstuaryMicrophone] Properties: ${props.join(', ')}`);
            
            // Verify getAudioFrame is available
            if (typeof audioInput.getAudioFrame !== 'function') {
                print(`[EstuaryMicrophone] ⚠️ WARNING: getAudioFrame not found!`);
                print(`[EstuaryMicrophone] Make sure you're passing a MicrophoneAudioProvider,`);
                print(`[EstuaryMicrophone] not AudioTrackAsset.control`);
            } else {
                print(`[EstuaryMicrophone] ✅ getAudioFrame method available`);
            }
            
            // Capture the actual input sample rate for resampling
            if ('sampleRate' in audioInput && typeof audioInput['sampleRate'] === 'number') {
                this._inputSampleRate = audioInput['sampleRate'];
                print(`[EstuaryMicrophone] Audio Input Configuration:`);
                print(`[EstuaryMicrophone]   Input sample rate: ${this._inputSampleRate}Hz`);
                print(`[EstuaryMicrophone]   Target sample rate: ${this._sampleRate}Hz (for Deepgram)`);
                print(`[EstuaryMicrophone]   Streaming mode: ${this._streamImmediately ? 'IMMEDIATE (low latency)' : 'BUFFERED (' + this._chunkDurationMs + 'ms chunks)'}`);
                
                if (this._inputSampleRate !== this._sampleRate) {
                    const ratio = this._inputSampleRate / this._sampleRate;
                    print(`[EstuaryMicrophone]   Resample ratio: ${ratio.toFixed(2)}x`);
                } else {
                    print(`[EstuaryMicrophone]   No resampling needed`);
                }
            } else {
                print(`[EstuaryMicrophone] WARNING: Could not detect input sample rate, using default ${this._inputSampleRate}Hz`);
            }
            print(`[EstuaryMicrophone] ========================================`);
        }
        
        this.updateSampleBuffer();
        this.log('MicrophoneAudioProvider configured');
    }
    
    /**
     * Alternative method to set microphone provider directly.
     * This is the preferred method according to Lens Studio documentation.
     * 
     * @param provider The MicrophoneAudioProvider from an Audio From Microphone asset
     */
    setMicrophoneProvider(provider: MicrophoneAudioProvider): void {
        this.setAudioInput(provider);
    }
    
    /**
     * Set the MicrophoneRecorder from RemoteServiceGateway.lspkg
     * THIS IS THE RECOMMENDED METHOD for capturing microphone audio in Lens Studio.
     * 
     * The MicrophoneRecorder component provides event-based audio delivery which
     * works reliably in both the simulator and on real hardware.
     * 
     * Usage in your script:
     * ```typescript
     * import { MicrophoneRecorder } from "RemoteServiceGateway.lspkg/Helpers/MicrophoneRecorder";
     * 
     * @input private microphoneRecorder: MicrophoneRecorder;
     * 
     * // In onAwake:
     * this.microphone.setMicrophoneRecorder(this.microphoneRecorder);
     * ```
     * 
     * @param recorder The MicrophoneRecorder component from your scene
     */
    setMicrophoneRecorder(recorder: MicrophoneRecorder): void {
        this._microphoneRecorder = recorder;
        this._useEventBasedRecording = true;
        
        print('[EstuaryMicrophone] ========================================');
        print('[EstuaryMicrophone] Setting up MicrophoneRecorder...');
        
        // Debug: log available methods/properties
        const methods: string[] = [];
        const props: string[] = [];
        for (const key in recorder) {
            if (typeof (recorder as any)[key] === 'function') {
                methods.push(key);
            } else {
                props.push(key);
            }
        }
        print(`[EstuaryMicrophone] Available methods: ${methods.join(', ')}`);
        print(`[EstuaryMicrophone] Available props: ${props.join(', ')}`);
        
        // Set sample rate to match Deepgram requirements (if method exists)
        if (typeof recorder.setSampleRate === 'function') {
            recorder.setSampleRate(this._sampleRate);
            print(`[EstuaryMicrophone] Set sample rate to ${this._sampleRate}Hz`);
        } else {
            print(`[EstuaryMicrophone] ⚠️ setSampleRate not available, using default`);
        }
        
        // Subscribe to audio frame events
        if (recorder.onAudioFrame && typeof recorder.onAudioFrame.add === 'function') {
            recorder.onAudioFrame.add((audioFrame: Float32Array) => {
                this.handleAudioFrameEvent(audioFrame);
            });
            print('[EstuaryMicrophone] ✅ Subscribed to onAudioFrame events');
        } else {
            print('[EstuaryMicrophone] ❌ ERROR: onAudioFrame.add not available!');
            this._useEventBasedRecording = false;
        }
        
        print('[EstuaryMicrophone] ✅ MicrophoneRecorder configured (EVENT-BASED)');
        print('[EstuaryMicrophone] ========================================');
    }
    
    /**
     * Handle audio frame from MicrophoneRecorder event.
     * This is called automatically when MicrophoneRecorder provides audio.
     */
    private handleAudioFrameEvent(audioFrame: Float32Array): void {
        if (!this._isRecording) {
            return;
        }
        
        this._frameCount++;
        
        if (audioFrame && audioFrame.length > 0) {
            this._framesWithAudio++;
            this._consecutiveEmptyFrames = 0;
            
            // Calculate volume for debugging
            let maxSample = 0;
            for (let i = 0; i < audioFrame.length; i++) {
                const abs = Math.abs(audioFrame[i]);
                if (abs > maxSample) maxSample = abs;
            }
            this._currentVolume = calculateRMS(audioFrame);
            
            // Debug logging
            if (this._debugLogging && this._frameCount % 100 === 0) {
                print(`[EstuaryMicrophone] Event frame ${this._frameCount}: ${audioFrame.length} samples, volume=${this._currentVolume.toFixed(4)}, max=${maxSample.toFixed(4)}`);
            }
            
            // Send audio to backend
            this.sendAudioChunkEvent(audioFrame);
        } else {
            this._framesWithoutAudio++;
            this._consecutiveEmptyFrames++;
        }
    }
    
    /**
     * Send audio chunk from event-based recording.
     */
    private sendAudioChunkEvent(samples: Float32Array): void {
        if (!this._targetCharacter || !this._targetCharacter.isConnected) {
            return;
        }
        
        // Throttling: only send if enough time has passed since last send
        const now = Date.now();
        if (now - this._lastSendTime < this._minSendIntervalMs) {
            // Accumulate samples if we're throttling
            if (!this._pendingAudioBuffer) {
                this._pendingAudioBuffer = samples;
            } else {
                // Combine pending buffer with new samples
                const combined = new Float32Array(this._pendingAudioBuffer.length + samples.length);
                combined.set(this._pendingAudioBuffer, 0);
                combined.set(samples, this._pendingAudioBuffer.length);
                this._pendingAudioBuffer = combined;
            }
            return;
        }
        
        // Get samples to send (including any pending)
        let audioToSend = samples;
        if (this._pendingAudioBuffer && this._pendingAudioBuffer.length > 0) {
            const combined = new Float32Array(this._pendingAudioBuffer.length + samples.length);
            combined.set(this._pendingAudioBuffer, 0);
            combined.set(samples, this._pendingAudioBuffer.length);
            audioToSend = combined;
            this._pendingAudioBuffer = null;
        }
        
        // Convert to PCM16 and Base64
        const base64Audio = encodeAudio(audioToSend);
        
        // Send to character
        this._targetCharacter.streamAudio(base64Audio);
        this._lastSendTime = now;
        
        // Log first chunk
        if (!this._chunksSent || this._chunksSent === 0) {
            this._chunksSent = 1;
            print(`[EstuaryMicrophone] ✅ First audio chunk sent (event-based): ${audioToSend.length} samples @ ${this._sampleRate}Hz, base64 length=${base64Audio.length}`);
        } else {
            this._chunksSent++;
        }
        
        // Stats logging
        if (this._debugLogging && this._chunksSent % 20 === 0) {
            print(`[EstuaryMicrophone] Stats: sent=${this._chunksSent}, volume=${this._currentVolume.toFixed(4)}`);
        }
    }

    /**
     * Start recording from the microphone.
     */
    startRecording(): void {
        if (this._isRecording) {
            this.log('Already recording');
            return;
        }

        // Handle MicrophoneRecorder (event-based, recommended)
        if (this._useEventBasedRecording && this._microphoneRecorder) {
            this._isRecording = true;
            this._chunksSent = 0;
            this._frameCount = 0;
            this._framesWithAudio = 0;
            this._framesWithoutAudio = 0;
            
            this._microphoneRecorder.startRecording();
            print('[EstuaryMicrophone] Started EVENT-BASED recording via MicrophoneRecorder');
            this.emit('recordingStarted');
            return;
        }

        // Fallback: polling-based recording
        if (!this._audioInput && !this._generateTestTone) {
            print('[EstuaryMicrophone] Warning: AudioInput not set and test tone disabled - no audio will be captured');
        } else if (!this._audioInput && this._generateTestTone) {
            print('[EstuaryMicrophone] Test tone mode - will generate 440Hz sine wave (no microphone needed)');
            // Set input sample rate to target rate for test tone (avoids resampling)
            this._inputSampleRate = this._sampleRate;
        }

        // Start the audio input if it has a start method
        // This is required in Lens Studio to begin receiving audio frames
        if (this._audioInput && typeof this._audioInput.start === 'function') {
            try {
                this._audioInput.start();
                print('[EstuaryMicrophone] Called audioInput.start()');
            } catch (e) {
                print(`[EstuaryMicrophone] audioInput.start() error: ${e}`);
            }
        }

        this.updateSampleBuffer();
        this._bufferPosition = 0;
        this._isRecording = true;
        this._chunksSent = 0;
        this._chunksWithAudio = 0;

        const modeInfo = this._streamImmediately ? 'immediate streaming' : `${this._chunkDurationMs}ms chunks`;
        print(`[EstuaryMicrophone] Started recording at ${this._sampleRate}Hz (${modeInfo})`);
        this.emit('recordingStarted');
    }

    /**
     * Stop recording from the microphone.
     */
    stopRecording(): void {
        if (!this._isRecording) {
            return;
        }

        // Handle MicrophoneRecorder (event-based)
        if (this._useEventBasedRecording && this._microphoneRecorder) {
            this._microphoneRecorder.stopRecording();
            this._isRecording = false;
            
            // Log final stats
            if (this._chunksSent && this._chunksSent > 0) {
                print(`[EstuaryMicrophone] Recording stats: sent=${this._chunksSent}, frames=${this._frameCount}, withAudio=${this._framesWithAudio}`);
            }
            
            print('[EstuaryMicrophone] Stopped EVENT-BASED recording');
            this.emit('recordingStopped');
            return;
        }

        // Fallback: polling-based recording
        // Stop the audio input if it has a stop method
        if (this._audioInput && typeof this._audioInput.stop === 'function') {
            try {
                this._audioInput.stop();
                print('[EstuaryMicrophone] Called audioInput.stop()');
            } catch (e) {
                print(`[EstuaryMicrophone] audioInput.stop() error: ${e}`);
            }
        }

        this._isRecording = false;
        this._bufferPosition = 0;
        this._isSpeechDetected = false;
        this._wasSpeaking = false;

        // Log final stats
        if (this._chunksSent > 0) {
            print(`[EstuaryMicrophone] Recording stats: sent=${this._chunksSent}, withAudio=${this._chunksWithAudio} (${((this._chunksWithAudio/this._chunksSent)*100).toFixed(1)}%)`);
        }

        this.log('Stopped recording');
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
     * Process audio for the current frame.
     * Call this from an UpdateEvent in Lens Studio.
     * @param frameSize Number of samples to read this frame
     */
    processAudioFrame(frameSize: number): void {
        if (!this._isRecording || !this._sampleBuffer) {
            return;
        }

        // If test tone mode is enabled, we can skip the audio input requirement
        if (!this._audioInput && !this._generateTestTone) {
            return;
        }

        // Get audio samples from input
        // Lens Studio's getAudioFrame expects a Float32Array buffer to fill
        let samples: Float32Array | null = null;
        
        // Try different audio input methods depending on Lens Studio version
        if (this._audioInput && typeof this._audioInput.getAudioFrame === 'function') {
            try {
                // Create a buffer for the audio frame
                const frameBuffer = new Float32Array(frameSize);
                // getAudioFrame fills the buffer and returns the number of samples read
                const result = this._audioInput.getAudioFrame(frameBuffer);
                
                // Result could be a number (samples read) or the buffer itself depending on API version
                if (typeof result === 'number' && result > 0) {
                    // Create a COPY of the data (not a view with subarray)
                    // This prevents buffer corruption issues
                    samples = new Float32Array(result);
                    for (let i = 0; i < result; i++) {
                        samples[i] = frameBuffer[i];
                    }
                } else if (result instanceof Float32Array && result.length > 0) {
                    // Create a copy to be safe
                    samples = new Float32Array(result.length);
                    for (let i = 0; i < result.length; i++) {
                        samples[i] = result[i];
                    }
                } else if (frameBuffer.length > 0) {
                    // Check if the buffer was filled (non-zero values)
                    let hasData = false;
                    for (let i = 0; i < Math.min(10, frameBuffer.length); i++) {
                        if (frameBuffer[i] !== 0) {
                            hasData = true;
                            break;
                        }
                    }
                    if (hasData) {
                        // Create a copy
                        samples = new Float32Array(frameBuffer.length);
                        for (let i = 0; i < frameBuffer.length; i++) {
                            samples[i] = frameBuffer[i];
                        }
                    }
                }
            } catch (e) {
                // Log the error once
                if (this._debugLogging) {
                    print(`[EstuaryMicrophone] getAudioFrame error: ${e}`);
                }
            }
        }
        
        // Track frame statistics
        this._frameCount++;
        
        if (samples && samples.length > 0) {
            this._framesWithAudio++;
            this._consecutiveEmptyFrames = 0;
        } else {
            this._framesWithoutAudio++;
            this._consecutiveEmptyFrames++;
            
            // Detect simulator mode: many consecutive empty frames
            if (this._consecutiveEmptyFrames === 100 && !this._simulatorModeWarned) {
                this._simulatorModeWarned = true;
                print('[EstuaryMicrophone] ⚠️  WARNING: No audio data for 100 consecutive frames!');
                print('[EstuaryMicrophone] This usually means:');
                print('[EstuaryMicrophone]   1. Lens Studio Simulator does not stream real microphone audio');
                print('[EstuaryMicrophone]   2. To test, enable test tone: microphone.generateTestTone = true');
                print('[EstuaryMicrophone]   3. OR test on actual Spectacles hardware');
            }
        }
        
        // Debug logging every 100 frames
        if (this._debugLogging && this._frameCount % 100 === 0) {
            const audioRate = this._framesWithAudio / this._frameCount * 100;
            if (samples) {
                print(`[EstuaryMicrophone] Frame ${this._frameCount}: got ${samples.length} samples (${audioRate.toFixed(1)}% frames have audio)`);
            } else {
                print(`[EstuaryMicrophone] Frame ${this._frameCount}: no samples (${audioRate.toFixed(1)}% frames have audio)`);
            }
        }
        
        // If no samples from microphone, optionally generate test tone
        if (!samples || samples.length === 0) {
            if (this._generateTestTone) {
                samples = this.generateTestToneSamples(frameSize);
            } else {
                return;
            }
        }

        // Immediate streaming mode: send audio as soon as it's received
        // This provides lowest latency for real-time STT with Deepgram
        if (this._streamImmediately) {
            this.processAudioChunk(samples);
            return;
        }

        // Buffered mode: accumulate samples until we have a full chunk
        // This is useful for VAD-based streaming or when you need fixed chunk sizes
        const spaceInBuffer = this._sampleBuffer.length - this._bufferPosition;
        const samplesToCopy = Math.min(samples.length, spaceInBuffer);

        for (let i = 0; i < samplesToCopy; i++) {
            this._sampleBuffer[this._bufferPosition + i] = samples[i];
        }
        this._bufferPosition += samplesToCopy;

        // Check if buffer is full (one chunk complete)
        if (this._bufferPosition >= this._sampleBuffer.length) {
            this.processAudioChunk(this._sampleBuffer);
            this._bufferPosition = 0;

            // Handle overflow - copy remaining samples to start of buffer
            const overflow = samples.length - samplesToCopy;
            if (overflow > 0) {
                for (let i = 0; i < overflow; i++) {
                    this._sampleBuffer[i] = samples[samplesToCopy + i];
                }
                this._bufferPosition = overflow;
            }
        }
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        this.stopRecording();
        this._audioInput = null;
        this._targetCharacter = null;
        this._sampleBuffer = null;
        this.removeAllListeners();
    }

    // ==================== Private Methods ====================

    private updateSampleBuffer(): void {
        // Buffer size is based on INPUT sample rate since we collect at that rate
        // then resample to OUTPUT sample rate (16kHz for Deepgram)
        const inputRate = this._inputSampleRate || this._sampleRate;
        const samplesPerChunk = Math.floor((inputRate * this._chunkDurationMs) / 1000);
        this._sampleBuffer = new Float32Array(samplesPerChunk);
        this._bufferPosition = 0;
        
        if (this._debugLogging) {
            print(`[EstuaryMicrophone] Buffer size: ${samplesPerChunk} samples (${this._chunkDurationMs}ms @ ${inputRate}Hz)`);
        }
    }

    private processAudioChunk(samples: Float32Array): void {
        // Calculate volume
        this._currentVolume = calculateRMS(samples);
        this.emit('volumeChanged', this._currentVolume);

        // Voice activity detection
        if (this._useVoiceActivityDetection) {
            const isSpeaking = this._currentVolume > this._vadThreshold;

            if (isSpeaking && !this._wasSpeaking) {
                this._isSpeechDetected = true;
                this.emit('speechDetected');
            } else if (!isSpeaking && this._wasSpeaking) {
                this._isSpeechDetected = false;
                this.emit('silenceDetected');
            }

            this._wasSpeaking = isSpeaking;

            // Don't send audio if no speech detected
            if (!isSpeaking) {
                return;
            }
        }

        // Send audio chunk
        this.sendAudioChunk(samples);
    }

    private _chunksSent: number = 0;
    private _chunksWithAudio: number = 0;
    
    private sendAudioChunk(samples: Float32Array): void {
        if (!this._targetCharacter || !this._targetCharacter.isConnected) {
            if (this._debugLogging && this._chunksSent === 0) {
                print(`[EstuaryMicrophone] Not connected, skipping audio chunk`);
            }
            return;
        }

        // Resample if input sample rate differs from target (16kHz for Deepgram)
        let audioToSend = samples;
        if (this._inputSampleRate !== this._sampleRate) {
            audioToSend = resample(samples, this._inputSampleRate, this._sampleRate);
            // Only log first resample
            if (this._chunksSent === 0) {
                print(`[EstuaryMicrophone] Resampling: ${samples.length} @ ${this._inputSampleRate}Hz -> ${audioToSend.length} @ ${this._sampleRate}Hz`);
            }
        }

        // Check if audio has actual content (not silent)
        let maxSample = 0;
        for (let i = 0; i < audioToSend.length; i++) {
            const abs = Math.abs(audioToSend[i]);
            if (abs > maxSample) maxSample = abs;
        }
        
        if (maxSample > 0.01) {
            this._chunksWithAudio++;
        }

        // Throttle sends to prevent WebSocket buffer overflow
        // Lens Studio's WebSocket can corrupt messages if sent too quickly
        const now = Date.now();
        const timeSinceLastSend = now - this._lastSendTime;
        
        if (timeSinceLastSend < this._minSendIntervalMs) {
            // Too soon - accumulate audio in pending buffer
            if (!this._pendingAudioBuffer) {
                this._pendingAudioBuffer = new Float32Array(audioToSend);
            } else {
                // Append to pending buffer
                const combined = new Float32Array(this._pendingAudioBuffer.length + audioToSend.length);
                combined.set(this._pendingAudioBuffer);
                combined.set(audioToSend, this._pendingAudioBuffer.length);
                this._pendingAudioBuffer = combined;
            }
            return;
        }
        
        // Include any pending audio
        let finalAudio = audioToSend;
        if (this._pendingAudioBuffer) {
            const combined = new Float32Array(this._pendingAudioBuffer.length + audioToSend.length);
            combined.set(this._pendingAudioBuffer);
            combined.set(audioToSend, this._pendingAudioBuffer.length);
            finalAudio = combined;
            this._pendingAudioBuffer = null;
        }
        
        // Convert to Base64 PCM16
        const base64Audio = encodeAudio(finalAudio);
        
        this._chunksSent++;
        this._lastSendTime = now;
        
        // Log first chunk to confirm audio is being sent
        if (this._chunksSent === 1) {
            const mode = this._generateTestTone ? 'TEST TONE' : 'microphone';
            print(`[EstuaryMicrophone] ✅ First audio chunk sent (${mode}): ${finalAudio.length} samples @ ${this._sampleRate}Hz, base64 length=${base64Audio.length}`);
        }
        
        // Log every 20 chunks (once per second at 20 sends/sec)
        if (this._debugLogging && this._chunksSent % 20 === 0) {
            print(`[EstuaryMicrophone] Stats: sent=${this._chunksSent}, withAudio=${this._chunksWithAudio}, volume=${this._currentVolume.toFixed(4)}, maxSample=${maxSample.toFixed(4)}`);
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

    /**
     * Generate a test tone for simulator testing.
     * Creates a 440Hz sine wave to test audio streaming when the simulator
     * doesn't provide real microphone input.
     * 
     * Note: Generates at target sample rate (16kHz) to skip resampling.
     */
    private generateTestToneSamples(frameSize: number): Float32Array {
        // Generate at target sample rate to avoid resampling issues
        const sampleRate = this._sampleRate; // 16000Hz for Deepgram
        
        // Adjust frame size for the target sample rate if input rate is different
        // This ensures we generate the right amount of audio per frame
        const inputRate = this._inputSampleRate || sampleRate;
        const adjustedFrameSize = Math.floor(frameSize * sampleRate / inputRate);
        
        const samples = new Float32Array(adjustedFrameSize);
        const frequency = 440; // A4 note
        const amplitude = 0.3; // 30% volume to avoid clipping
        
        for (let i = 0; i < adjustedFrameSize; i++) {
            samples[i] = amplitude * Math.sin(2 * Math.PI * frequency * this._testTonePhase / sampleRate);
            this._testTonePhase++;
            
            // Prevent phase from growing too large
            if (this._testTonePhase >= sampleRate) {
                this._testTonePhase -= sampleRate;
            }
        }
        
        // Mark that this audio is already at target sample rate (skip resampling)
        // We do this by temporarily setting _inputSampleRate = _sampleRate
        // This is a bit of a hack but avoids more invasive changes
        if (!this._inputSampleRate) {
            this._inputSampleRate = this._sampleRate;
        }
        
        return samples;
    }
}

/**
 * Alternative microphone implementation using VoiceML for transcription.
 * This uses Lens Studio's built-in speech recognition instead of streaming audio.
 * 
 * Usage:
 * 1. Import VoiceMLModule in your project
 * 2. Use VoiceMLMicrophone to get transcriptions
 * 3. Send transcriptions as text to EstuaryCharacter
 */
export class VoiceMLMicrophone extends EventEmitter<any> {
    private _targetCharacter: EstuaryCharacter | null = null;
    private _isListening: boolean = false;

    constructor(targetCharacter?: EstuaryCharacter) {
        super();
        if (targetCharacter) {
            this._targetCharacter = targetCharacter;
        }
    }

    get targetCharacter(): EstuaryCharacter | null {
        return this._targetCharacter;
    }

    set targetCharacter(character: EstuaryCharacter | null) {
        this._targetCharacter = character;
    }

    get isListening(): boolean {
        return this._isListening;
    }

    /**
     * Handle transcription result from VoiceML.
     * Call this from your VoiceML callback.
     * @param text Transcribed text
     * @param isFinal Whether this is a final result
     */
    handleTranscription(text: string, isFinal: boolean): void {
        this.emit('transcription', text, isFinal);

        // Send final transcriptions to character
        if (isFinal && this._targetCharacter && this._targetCharacter.isConnected) {
            this._targetCharacter.sendText(text);
        }
    }

    /**
     * Notify that listening has started.
     */
    notifyStarted(): void {
        this._isListening = true;
        this.emit('started');
    }

    /**
     * Notify that listening has stopped.
     */
    notifyStopped(): void {
        this._isListening = false;
        this.emit('stopped');
    }
}

/**
 * Create an EstuaryMicrophone for use with Lens Studio.
 * 
 * Example usage in a Lens Studio script:
 * ```typescript
 * @component
 * export class MyScript extends BaseScriptComponent {
 *     @input audioInput: AudioTrackAsset;
 *     
 *     private microphone: EstuaryMicrophone;
 *     private character: EstuaryCharacter;
 *     
 *     onAwake() {
 *         this.microphone = new EstuaryMicrophone(this.character);
 *         this.microphone.setAudioInput(this.audioInput.control);
 *     }
 *     
 *     onUpdate() {
 *         this.microphone.processAudioFrame(1024);
 *     }
 * }
 * ```
 */
export function createMicrophone(
    targetCharacter: EstuaryCharacter,
    audioInputControl?: AudioInputControl
): EstuaryMicrophone {
    const mic = new EstuaryMicrophone(targetCharacter);
    if (audioInputControl) {
        mic.setAudioInput(audioInputControl);
    }
    return mic;
}





