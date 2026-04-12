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

    /** Timestamp of last audio send (for diagnostics) */
    private _lastSendTime: number = 0;

    /** Buffer for accumulating small audio frames into sendable chunks */
    private _pendingAudioBuffer: Float32Array | null = null;

    /**
     * Minimum samples before sending a chunk. 1600 = 100ms at 16kHz.
     *
     * Raised from 1280 (80ms) to give the EstuaryClient send queue headroom
     * over its 75ms inter-send gap. At 80ms chunk cadence the effective max
     * send rate (75ms gap + ~8ms tick jitter ≈ 83ms per cycle → 12/sec) was
     * slightly BELOW the arrival rate (12.25/sec), causing the queue to creep
     * toward the drop threshold. 100ms chunks give ~25ms of headroom so the
     * queue drains cleanly at steady state and matches RSG's AudioProcessor
     * default send rate.
     */
    private _minChunkSamples: number = 1600;

    // ==================== Silence Padding ====================
    /**
     * When true, synthesize zero-valued samples each tick to keep the outgoing
     * audio stream locked to wall-clock time at the configured sample rate.
     *
     * Spectacles' MicrophoneAudioProvider silently drops ~22-26% of frames
     * (likely VoiceML bystander rejection / silence gating), so the effective
     * rate arriving at Deepgram is ~14kHz when we claim 16kHz. Deepgram's
     * endpointing waits for silence IN THE AUDIO to fire end-of-utterance,
     * which never happens if we strip silence. Padding with zeros restores
     * a continuous wall-clock-accurate stream, fixes endpointing, and
     * restores phoneme-duration correctness for STT accuracy.
     */
    private _padSilence: boolean = true;
    /** Wall-clock time when this recording session started (ms). */
    private _recordingStartMs: number = 0;
    /** Running total of samples (real + synthesized silence) fed to sendAudioToBackend. */
    private _totalSamplesEnqueued: number = 0;
    /** Cumulative synthesized silence samples for diagnostics. */
    private _diagSilenceSamples: number = 0;

    // ==================== Diagnostics ====================
    /** Timestamp of first audio frame after recording started (for sample-rate inference) */
    private _diagFirstFrameMs: number = 0;
    /** Accumulated samples since recording started, for sample-rate inference */
    private _diagSamplesSinceStart: number = 0;
    /** Last chunk send timestamp used to compute inter-chunk cadence */
    private _diagLastChunkMs: number = 0;
    /** Rolling sum of inter-chunk intervals for cadence stats */
    private _diagChunkIntervalSumMs: number = 0;
    /** Count of sampled inter-chunk intervals */
    private _diagChunkIntervalSamples: number = 0;
    /** Count of frames where audioFrame was null or length 0 */
    private _diagEmptyFrameCount: number = 0;
    /** Min frame size observed (non-empty) */
    private _diagMinFrameSamples: number = 0;
    /** Max frame size observed */
    private _diagMaxFrameSamples: number = 0;

    // ==================== Direct-Mic Mode (bypasses RSG) ====================
    /** When true, pull audio directly from AudioTrackAsset.control instead of RSG's MicrophoneRecorder */
    private _directMode: boolean = false;
    /** MicrophoneAudioProvider obtained from AudioTrackAsset.control when in direct mode */
    private _directAudioProvider: any = null;
    /** Pre-allocated Int16 buffer for getAudioFramePCM16 (avoids GC churn) */
    private _directPcmBuffer: Int16Array | null = null;
    /** Pre-allocated Float32 fallback buffer for getAudioFrame */
    private _directFloatBuffer: Float32Array | null = null;
    /** Whether getAudioFramePCM16 is available on the provider */
    private _directUsePcmNative: boolean = false;

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

            // ---- DIAGNOSTIC: read the actual sample rate back ----
            // RSG's MicrophoneRecorder stores a `private micAudioProvider` on the
            // underlying ScriptComponent. In JS private is not enforced, so we
            // can peek at it. If the platform silently clamps or rejects our
            // requested rate, we need to know — Deepgram receiving pitch-shifted
            // audio looks exactly like "voice chat is slow."
            try {
                const provider = (recorder as any).micAudioProvider;
                if (provider) {
                    const actualRate = provider.sampleRate;
                    const maxFrameSize = provider.maxFrameSize;
                    print(
                        `[EstuaryDiag] MIC requested_rate=${this._sampleRate} ` +
                        `actual_rate=${actualRate} maxFrameSize=${maxFrameSize}`
                    );
                    if (typeof actualRate === 'number' && actualRate !== this._sampleRate) {
                        print(
                            `[EstuaryDiag] ⚠️ SAMPLE RATE MISMATCH — requested ` +
                            `${this._sampleRate} but got ${actualRate}. Deepgram will ` +
                            `receive pitch-shifted audio and STT will fail or lag.`
                        );
                    }
                } else {
                    print('[EstuaryDiag] MIC provider introspection unavailable (no .micAudioProvider field)');
                }
            } catch (e) {
                print('[EstuaryDiag] MIC provider readback threw: ' + e);
            }
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
     * DIRECT MODE: set up mic capture by talking to the AudioTrackAsset's
     * MicrophoneAudioProvider ourselves, bypassing RSG's MicrophoneRecorder.
     *
     * This path uses a pre-allocated Int16 buffer with `getAudioFramePCM16()`
     * when available (native Float→Int16 conversion), falling back to
     * `getAudioFrame()` + Float32 path otherwise.
     *
     * After calling this, the host script must call `pullAudioFrames()` once
     * per UpdateEvent tick to drain the provider's buffer.
     *
     * @param audioTrack The mic AudioTrackAsset from the scene
     */
    setAudioTrackAsset(audioTrack: any): void {
        print('[EstuaryMicrophone] ========================================');
        print('[EstuaryMicrophone] Setting up DIRECT mic capture (RSG bypass)...');

        if (!audioTrack) {
            print('[EstuaryMicrophone] ❌ ERROR: audioTrack is null');
            return;
        }

        const provider: any = audioTrack.control;
        if (!provider) {
            print('[EstuaryMicrophone] ❌ ERROR: audioTrack.control is null — not a mic track?');
            return;
        }

        this._directMode = true;
        this._directAudioProvider = provider;

        // Set sample rate
        try {
            provider.sampleRate = this._sampleRate;
        } catch (e) {
            print('[EstuaryMicrophone] sampleRate assignment threw: ' + e);
        }

        const actualRate = provider.sampleRate;
        const maxFrameSize = provider.maxFrameSize;
        print(
            `[EstuaryDiag] DIRECT_MIC requested_rate=${this._sampleRate} ` +
            `actual_rate=${actualRate} maxFrameSize=${maxFrameSize}`
        );

        // Prefer native PCM16 conversion if available
        this._directUsePcmNative = typeof provider.getAudioFramePCM16 === 'function';
        print(`[EstuaryDiag] DIRECT_MIC use_pcm_native=${this._directUsePcmNative}`);

        // Pre-allocate a reasonable buffer: ~128ms at 16kHz = 2048 samples.
        // Smaller than RSG's maxFrameSize (16384) to avoid over-allocation per call
        // and to make it obvious if the provider under-delivers vs our request.
        const bufferSize = Math.min(2048, maxFrameSize || 2048);
        this._directPcmBuffer = new Int16Array(bufferSize);
        this._directFloatBuffer = new Float32Array(bufferSize);
        print(
            `[EstuaryDiag] DIRECT_MIC buffer_size=${bufferSize} samples ` +
            `(~${Math.round((bufferSize * 1000) / this._sampleRate)}ms at ${this._sampleRate}Hz)`
        );

        print('[EstuaryMicrophone] ✅ Direct mic capture configured');
        print('[EstuaryMicrophone] ========================================');
    }

    /**
     * Pull any available audio frames from the direct-mode provider.
     * Must be called from the host's UpdateEvent loop ~60 times per second
     * when `setAudioTrackAsset()` was used to set up capture.
     *
     * No-op when not in direct mode or not recording.
     */
    pullAudioFrames(): void {
        if (!this._directMode || !this._isRecording || !this._directAudioProvider) {
            return;
        }

        try {
            if (this._directUsePcmNative && this._directPcmBuffer) {
                // Native PCM16 path — no TS-side Float→Int16 conversion
                const shape = this._directAudioProvider.getAudioFramePCM16(this._directPcmBuffer);
                const count = shape && typeof shape.x === 'number' ? shape.x : 0;

                // Convert Int16 → Float32 for the existing accumulation pipeline.
                // (Could be optimized later by feeding Int16 directly all the way.)
                if (count > 0) {
                    const floatFrame = new Float32Array(count);
                    for (let i = 0; i < count; i++) {
                        floatFrame[i] = this._directPcmBuffer[i] / 32768;
                    }
                    this.handleAudioFrame(floatFrame);
                } else {
                    // Still count the empty tick so we can measure dropout rate
                    this.handleAudioFrame(new Float32Array(0));
                }
            } else if (this._directFloatBuffer) {
                // Fallback Float32 path
                const shape = this._directAudioProvider.getAudioFrame(this._directFloatBuffer);
                const count = shape && typeof shape.x === 'number' ? shape.x : 0;
                const frame = count > 0
                    ? this._directFloatBuffer.subarray(0, count)
                    : new Float32Array(0);
                this.handleAudioFrame(frame);
            }
        } catch (e) {
            print('[EstuaryDiag] DIRECT_MIC pullAudioFrames threw: ' + e);
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

        if (!this._directMode && !this._microphoneRecorder) {
            print('[EstuaryMicrophone] ❌ ERROR: No mic source! Call setMicrophoneRecorder() or setAudioTrackAsset() first.');
            return;
        }

        this._isRecording = true;
        this._chunksSent = 0;
        this._frameCount = 0;
        this._framesWithAudio = 0;
        this._pendingAudioBuffer = null;
        // Silence padding state — reset so the wall-clock-vs-enqueued ratio starts fresh
        this._recordingStartMs = Date.now();
        this._totalSamplesEnqueued = 0;
        // Reset diagnostics so sample-rate / cadence measurements restart cleanly
        this._diagFirstFrameMs = 0;
        this._diagSamplesSinceStart = 0;
        this._diagLastChunkMs = 0;
        this._diagChunkIntervalSumMs = 0;
        this._diagChunkIntervalSamples = 0;
        this._diagEmptyFrameCount = 0;
        this._diagMinFrameSamples = 0;
        this._diagMaxFrameSamples = 0;
        this._diagSilenceSamples = 0;

        if (this._directMode && this._directAudioProvider) {
            try {
                this._directAudioProvider.start();
            } catch (e) {
                print('[EstuaryMicrophone] direct provider.start() threw: ' + e);
            }
            print('[EstuaryDiag] DIRECT_MIC started (host must call pullAudioFrames every tick)');
        } else if (this._microphoneRecorder) {
            this._microphoneRecorder.startRecording();
        }

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

        if (this._directMode && this._directAudioProvider) {
            try {
                this._directAudioProvider.stop();
            } catch (e) {
                print('[EstuaryMicrophone] direct provider.stop() threw: ' + e);
            }
        } else if (this._microphoneRecorder) {
            this._microphoneRecorder.stopRecording();
        }

        // Flush any remaining buffered audio so the tail end of speech isn't lost
        if (this._pendingAudioBuffer && this._pendingAudioBuffer.length > 0 && this._targetCharacter?.isConnected) {
            const chunk = this._pendingAudioBuffer;
            this._pendingAudioBuffer = null;
            const pcmBytes = floatToPCM16(chunk);
            const base64Audio = Base64.encode(pcmBytes);
            this._chunksSent++;
            this._targetCharacter.streamAudio(base64Audio);
        }
        this._pendingAudioBuffer = null;

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
        this._pendingAudioBuffer = null;
        this._microphoneRecorder = null;
        this._targetCharacter = null;
        this.removeAllListeners();
    }

    // ==================== Private Methods ====================

    /**
     * Handle audio frame from MicrophoneRecorder event.
     */
    private handleAudioFrame(audioFrame: Float32Array): void {
        // Log first frame unconditionally for diagnostics (even if not recording)
        if (this._frameCount === 0 && !this._isRecording) {
            print(`[EstuaryMicrophone] DIAG: onAudioFrame fired but _isRecording=false, frame exists=${!!audioFrame}, length=${audioFrame?.length || 0}`);
        }

        if (!this._isRecording) {
            return;
        }

        this._frameCount++;
        const frameLen = audioFrame ? audioFrame.length : 0;

        // One-time diagnostic log on first frame while recording
        if (this._frameCount === 1) {
            print(`[EstuaryMicrophone] DIAG: First audio frame while recording — length=${frameLen}, isRecording=${this._isRecording}`);
            this._diagFirstFrameMs = Date.now();
            this._diagSamplesSinceStart = 0;
        }

        // ---- DIAGNOSTIC: log first 10 frame sizes so we see the distribution ----
        if (this._frameCount <= 10) {
            print(`[EstuaryDiag] MIC frame #${this._frameCount} size=${frameLen}`);
        }

        // Track empty frames separately so we can tell if the 72% loss is
        // frame-drop (empty frames count normally but carry nothing) vs
        // consistently-small frames (actual rate mismatch).
        if (frameLen === 0) {
            this._diagEmptyFrameCount++;
        } else {
            if (this._diagMinFrameSamples === 0 || frameLen < this._diagMinFrameSamples) {
                this._diagMinFrameSamples = frameLen;
            }
            if (frameLen > this._diagMaxFrameSamples) {
                this._diagMaxFrameSamples = frameLen;
            }
        }

        if (frameLen > 0) {
            this._framesWithAudio++;

            // ---- DIAGNOSTIC: infer effective capture sample rate from wall-clock + sample count ----
            // If configured is 16000 but we measure ~48000, Spectacles silently
            // overrode our setSampleRate request.
            this._diagSamplesSinceStart += frameLen;
            if (this._frameCount === 60 || this._frameCount === 300 || this._frameCount === 900) {
                const elapsedMs = Date.now() - this._diagFirstFrameMs;
                const measuredHz = elapsedMs > 0
                    ? Math.round((this._diagSamplesSinceStart * 1000) / elapsedMs)
                    : 0;
                // Divide samples by frames-with-audio for the true average non-empty frame size
                const avgNonEmptyFrame = this._framesWithAudio > 0
                    ? Math.round(this._diagSamplesSinceStart / this._framesWithAudio)
                    : 0;
                const emptyPct = this._frameCount > 0
                    ? Math.round((this._diagEmptyFrameCount * 100) / this._frameCount)
                    : 0;
                print(
                    `[EstuaryDiag] MIC measured over ${this._frameCount} frames: ` +
                    `elapsed_ms=${elapsedMs} total_samples=${this._diagSamplesSinceStart} ` +
                    `measured_hz=${measuredHz} frames_with_audio=${this._framesWithAudio} ` +
                    `empty_frames=${this._diagEmptyFrameCount} (${emptyPct}%) ` +
                    `avg_nonempty_samples=${avgNonEmptyFrame} ` +
                    `min=${this._diagMinFrameSamples} max=${this._diagMaxFrameSamples} ` +
                    `configured_hz=${this._sampleRate}`
                );
                if (measuredHz > 0 && Math.abs(measuredHz - this._sampleRate) > this._sampleRate * 0.1) {
                    print(
                        `[EstuaryDiag] ⚠️ EFFECTIVE RATE MISMATCH — measured ${measuredHz}Hz ` +
                        `but configured ${this._sampleRate}Hz. Deepgram is receiving ` +
                        `pitch-shifted audio; STT will degrade badly.`
                    );
                }
            }

            // Debug logging every 100 frames
            if (this._debugLogging && this._frameCount % 100 === 0) {
                print(`[EstuaryMicrophone] Frame ${this._frameCount}: ${frameLen} samples`);
            }

            // Send real audio to backend
            this.sendAudioToBackend(audioFrame);
            this._totalSamplesEnqueued += frameLen;
        }

        // ---- SILENCE PADDING ----
        // Runs on EVERY tick (even empty ones) so that the outgoing stream
        // stays locked to wall-clock time at the configured sample rate.
        // Without this, the ~22-26% empty ticks observed on Spectacles produce
        // a ~14 kHz effective rate to Deepgram, breaking endpointing and
        // distorting phoneme durations.
        if (this._padSilence && this._isRecording && this._recordingStartMs > 0) {
            const elapsedMs = Date.now() - this._recordingStartMs;
            const expectedSamples = Math.round((elapsedMs * this._sampleRate) / 1000);
            let deficit = expectedSamples - this._totalSamplesEnqueued;
            // Ignore sub-tick jitter (<2ms worth of samples) so we don't
            // spam the accumulator with tiny writes under small clock drift.
            if (deficit > (this._sampleRate / 500)) {
                // Clamp pathological catch-ups (e.g. right after startRecording)
                // so a single tick can't dump seconds of silence at once.
                const maxBurst = this._sampleRate; // 1 second cap
                if (deficit > maxBurst) {
                    deficit = maxBurst;
                }
                const silence = new Float32Array(deficit); // zero-filled
                this.sendAudioToBackend(silence);
                this._totalSamplesEnqueued += deficit;
                this._diagSilenceSamples += deficit;
            }

            // Print silence-padding health every 300 frames so we can see
            // how much of the outgoing stream is real vs synthesized.
            if (this._frameCount === 60 || this._frameCount === 300 || this._frameCount === 900) {
                const realSamples = this._totalSamplesEnqueued - this._diagSilenceSamples;
                const silencePct = this._totalSamplesEnqueued > 0
                    ? Math.round((this._diagSilenceSamples * 100) / this._totalSamplesEnqueued)
                    : 0;
                const effectiveHz = elapsedMs > 0
                    ? Math.round((this._totalSamplesEnqueued * 1000) / elapsedMs)
                    : 0;
                print(
                    `[EstuaryDiag] PADDING after ${this._frameCount} frames: ` +
                    `total_enqueued=${this._totalSamplesEnqueued} real=${realSamples} ` +
                    `silence=${this._diagSilenceSamples} (${silencePct}%) ` +
                    `effective_hz=${effectiveHz} target=${this._sampleRate}`
                );
            }
        }
    }

    /**
     * Send audio to the backend with Base64 encoding.
     * Accumulates small frames into chunks of at least _minChunkSamples (~80ms)
     * before sending, to avoid flooding EstuaryClient's send queue on Spectacles
     * where MicrophoneRecorder delivers tiny frames (128-288 samples) at ~60fps.
     * Uses native Lens Studio Base64 class for hardware compatibility.
     */
    private sendAudioToBackend(samples: Float32Array): void {
        if (!this._targetCharacter || !this._targetCharacter.isConnected) {
            if (this._chunksSent === 0) {
                print(`[EstuaryMicrophone] DIAG: Audio not sent — targetCharacter=${!!this._targetCharacter}, isConnected=${this._targetCharacter?.isConnected}`);
            }
            return;
        }

        // Accumulate small frames into larger chunks to avoid flooding the send queue
        if (this._pendingAudioBuffer) {
            const combined = new Float32Array(this._pendingAudioBuffer.length + samples.length);
            combined.set(this._pendingAudioBuffer);
            combined.set(samples, this._pendingAudioBuffer.length);
            this._pendingAudioBuffer = combined;
        } else {
            this._pendingAudioBuffer = new Float32Array(samples);
        }

        // Wait until we have enough audio for a meaningful chunk
        if (this._pendingAudioBuffer.length < this._minChunkSamples) {
            return;
        }

        // Send the accumulated chunk
        const chunk = this._pendingAudioBuffer;
        this._pendingAudioBuffer = null;

        const pcmBytes = floatToPCM16(chunk);
        const base64Audio = Base64.encode(pcmBytes);

        this._chunksSent++;
        const nowMs = Date.now();

        // ---- DIAGNOSTIC: track inter-chunk cadence ----
        // This chunk interval should be ~80ms at 16kHz (1280 samples).
        // If the actual interval drifts up, it means the update loop is
        // stalling and the send queue will back up.
        if (this._diagLastChunkMs > 0) {
            const interval = nowMs - this._diagLastChunkMs;
            this._diagChunkIntervalSumMs += interval;
            this._diagChunkIntervalSamples++;
        }
        this._diagLastChunkMs = nowMs;
        this._lastSendTime = nowMs;

        // Log first chunk to confirm audio is being sent
        if (this._chunksSent === 1) {
            print(`[EstuaryMicrophone] ✅ First audio chunk sent: ${chunk.length} samples @ ${this._sampleRate}Hz, base64 length=${base64Audio.length}`);
        }

        // Cadence stats every 20 chunks
        if (this._chunksSent % 20 === 0 && this._diagChunkIntervalSamples > 0) {
            const avg = (this._diagChunkIntervalSumMs / this._diagChunkIntervalSamples).toFixed(1);
            const expected = Math.round((this._minChunkSamples * 1000) / this._sampleRate);
            print(
                `[EstuaryDiag] MIC chunk cadence over ${this._diagChunkIntervalSamples} samples: ` +
                `avg=${avg}ms expected~${expected}ms chunks_sent=${this._chunksSent} ` +
                `frames=${this._frameCount}`
            );
            this._diagChunkIntervalSumMs = 0;
            this._diagChunkIntervalSamples = 0;
        }

        this._targetCharacter.streamAudio(base64Audio);
        this.emit('audioChunkSent', chunk.length);
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
