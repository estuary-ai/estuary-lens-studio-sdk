
/**
 * Audio player component for Estuary voice responses in Lens Studio.
 * Uses Lens Studio's Audio Output API to stream PCM audio data.
 * 
 * Usage:
 * 1. Create an Audio Output asset in Lens Studio
 * 2. Create an Audio component and assign the Audio Output
 * 3. Create an EstuaryAudioPlayer and pass the audio output control
 * 4. Connect to an EstuaryCharacter
 */

import { BotVoice } from '../Models/BotVoice';
import { IEstuaryAudioPlayer } from './EstuaryCharacter';
import { decodeAudio } from '../Utilities/Base64Helper';
import { DEFAULT_PLAYBACK_SAMPLE_RATE } from '../Utilities/AudioConverter';
import { EventEmitter } from '../Core/EstuaryEvents';

/**
 * Event types for EstuaryAudioPlayer
 */
export interface EstuaryAudioPlayerEvents {
    playbackStarted: () => void;
    playbackComplete: () => void;
    audioEnqueued: (chunkIndex: number) => void;
}

/**
 * Interface for Lens Studio's Audio Output control.
 * Using 'any' to be compatible with Lens Studio's AudioTrackProvider.
 * 
 * The actual Lens Studio AudioOutputProvider has methods like:
 * - enqueueAudioFrame(data, shape)
 * - getPreferredFrameSize()
 * - sampleRate (property)
 */
export type AudioOutputControl = any;

/**
 * EstuaryAudioPlayer - Handles playback of AI voice responses.
 * Implements IEstuaryAudioPlayer interface for use with EstuaryCharacter.
 */
export class EstuaryAudioPlayer 
    extends EventEmitter<any> 
    implements IEstuaryAudioPlayer {

    // ==================== Configuration ====================

    /** Sample rate for playback (default: 24000 for ElevenLabs) */
    private _sampleRate: number = DEFAULT_PLAYBACK_SAMPLE_RATE;

    /** Auto interrupt when new audio arrives while playing */
    private _autoInterrupt: boolean = false;

    /** Debug logging enabled */
    private _debugLogging: boolean = false;

    // ==================== State ====================

    /** Queue of audio chunks waiting to be played */
    private _audioQueue: Float32Array[] = [];

    /** Current position in the current chunk */
    private _currentChunkPosition: number = 0;

    /** Whether playback is currently active */
    private _isPlaying: boolean = false;

    /** Current message ID being played */
    private _currentMessageId: string = '';

    /** Audio output control from Lens Studio */
    private _audioOutput: AudioOutputControl | null = null;

    /** Update callback reference for cleanup */
    private _updateCallback: (() => void) | null = null;

    // ==================== Constructor ====================

    constructor(audioOutput?: AudioOutputControl) {
        super();
        if (audioOutput) {
            this.setAudioOutput(audioOutput);
        }
    }

    // ==================== Properties ====================

    get sampleRate(): number {
        return this._sampleRate;
    }

    set sampleRate(value: number) {
        this._sampleRate = value;
        if (this._audioOutput && typeof this._audioOutput.sampleRate !== 'undefined') {
            this._audioOutput.sampleRate = value;
        }
    }

    get autoInterrupt(): boolean {
        return this._autoInterrupt;
    }

    set autoInterrupt(value: boolean) {
        this._autoInterrupt = value;
    }

    get debugLogging(): boolean {
        return this._debugLogging;
    }

    set debugLogging(value: boolean) {
        this._debugLogging = value;
    }

    get isPlaying(): boolean {
        return this._isPlaying;
    }

    get queueLength(): number {
        return this._audioQueue.length;
    }

    // ==================== Public Methods ====================

    /**
     * Set the audio output control from Lens Studio.
     * @param audioOutput The AudioTrackProvider control from an Audio Output asset
     */
    setAudioOutput(audioOutput: AudioOutputControl): void {
        this._audioOutput = audioOutput;
        // Try to set sample rate if the API supports it
        if (this._audioOutput && typeof this._audioOutput.sampleRate !== 'undefined') {
            this._audioOutput.sampleRate = this._sampleRate;
        }
        this.log(`Audio output configured with sample rate ${this._sampleRate}`);
    }

    /**
     * Enqueue audio for playback.
     * @param voice BotVoice containing the audio data
     */
    enqueueAudio(voice: BotVoice): void {
        if (!voice.audio || voice.audio.length === 0) {
            this.log('Received empty audio, ignoring');
            return;
        }

        // Check if this is a new message and auto-interrupt is enabled
        if (this._autoInterrupt && voice.messageId !== this._currentMessageId && this._isPlaying) {
            this.log('New message received, interrupting current playback');
            this.stopPlayback();
        }

        // Update current message ID
        this._currentMessageId = voice.messageId;

        // Update sample rate if different
        if (voice.sampleRate && voice.sampleRate !== this._sampleRate) {
            this._sampleRate = voice.sampleRate;
            if (this._audioOutput) {
                this._audioOutput.sampleRate = voice.sampleRate;
            }
        }

        // Decode audio from base64 to Float32Array
        const audioData = decodeAudio(voice.audio);
        
        if (audioData.length === 0) {
            this.log('Failed to decode audio data');
            return;
        }

        this.log(`Enqueued audio chunk ${voice.chunkIndex}: ${audioData.length} samples`);

        // Add to queue
        this._audioQueue.push(audioData);
        this.emit('audioEnqueued', voice.chunkIndex);

        // Start playback if not already playing
        if (!this._isPlaying) {
            this.startPlayback();
        }
    }

    /**
     * Stop playback and clear the queue.
     */
    stopPlayback(): void {
        this._isPlaying = false;
        this._audioQueue = [];
        this._currentChunkPosition = 0;
        this.log('Playback stopped');
    }

    /**
     * Process audio for the current frame.
     * Call this from an UpdateEvent in Lens Studio.
     */
    processAudioFrame(): void {
        if (!this._isPlaying || !this._audioOutput) {
            return;
        }

        // Get the preferred frame size (default to 1024 if method not available)
        let frameSize = 1024;
        if (typeof this._audioOutput.getPreferredFrameSize === 'function') {
            frameSize = this._audioOutput.getPreferredFrameSize();
        }
        if (frameSize <= 0) {
            frameSize = 1024;
        }

        // Create buffer for this frame - try to use native buffer if available
        let frameData: Float32Array;
        
        // Check if the audio output has a method to allocate native buffers
        if (typeof this._audioOutput.allocateAudioFrame === 'function') {
            frameData = this._audioOutput.allocateAudioFrame(frameSize);
        } else {
            frameData = new Float32Array(frameSize);
        }
        
        let framePosition = 0;

        // Fill the frame with audio data from the queue
        while (framePosition < frameSize && this._audioQueue.length > 0) {
            const currentChunk = this._audioQueue[0];
            const remainingInChunk = currentChunk.length - this._currentChunkPosition;
            const remainingInFrame = frameSize - framePosition;
            const toCopy = Math.min(remainingInChunk, remainingInFrame);

            // Copy samples
            for (let i = 0; i < toCopy; i++) {
                frameData[framePosition + i] = currentChunk[this._currentChunkPosition + i];
            }

            framePosition += toCopy;
            this._currentChunkPosition += toCopy;

            // If we've finished the current chunk, move to next
            if (this._currentChunkPosition >= currentChunk.length) {
                this._audioQueue.shift();
                this._currentChunkPosition = 0;
            }
        }

        // If we have data, enqueue it
        if (framePosition > 0) {
            try {
                // Try to enqueue the frame using Lens Studio's API
                if (typeof this._audioOutput.enqueueAudioFrame === 'function') {
                    // Lens Studio requires a proper vec3 for the shape parameter
                    // Using plain {x, y, z} object causes "Value is not a native object" error
                    // For mono audio: x=frameSize, y=1 (channels), z=1
                    const shape = new vec3(framePosition, 1, 1);
                    
                    // Trim the buffer if we didn't fill it completely
                    if (framePosition < frameSize) {
                        const trimmedData = new Float32Array(framePosition);
                        for (let i = 0; i < framePosition; i++) {
                            trimmedData[i] = frameData[i];
                        }
                        this._audioOutput.enqueueAudioFrame(trimmedData, shape);
                    } else {
                        this._audioOutput.enqueueAudioFrame(frameData, shape);
                    }
                    
                    if (this._debugLogging) {
                        this.log(`Enqueued ${framePosition} samples`);
                    }
                }
            } catch (e) {
                // Log the error but continue trying - Lens Studio API compatibility issue
                if (this._debugLogging) {
                    print(`[EstuaryAudioPlayer] enqueueAudioFrame error: ${e}`);
                }
            }
        }

        // Check if playback is complete
        if (this._audioQueue.length === 0 && framePosition === 0) {
            this._isPlaying = false;
            this.log('Playback complete');
            this.emit('playbackComplete');
        }
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        this.stopPlayback();
        this._audioOutput = null;
        this.removeAllListeners();
    }

    // ==================== Private Methods ====================

    private startPlayback(): void {
        if (this._isPlaying || this._audioQueue.length === 0) {
            return;
        }

        this._isPlaying = true;
        this._currentChunkPosition = 0;
        this.log('Playback started');
        this.emit('playbackStarted');
    }

    private log(message: string): void {
        if (this._debugLogging) {
            print(`[EstuaryAudioPlayer] ${message}`);
        }
    }
}

/**
 * Create an EstuaryAudioPlayer for use with Lens Studio ScriptComponent.
 * 
 * Example usage in a Lens Studio script:
 * ```typescript
 * @component
 * export class MyScript extends BaseScriptComponent {
 *     @input audioOutput: AudioTrackAsset;
 *     
 *     private player: EstuaryAudioPlayer;
 *     
 *     onAwake() {
 *         const control = this.audioOutput.control as AudioOutputControl;
 *         this.player = new EstuaryAudioPlayer(control);
 *     }
 *     
 *     // Connect to UpdateEvent to process audio frames
 *     onUpdate() {
 *         this.player.processAudioFrame();
 *     }
 * }
 * ```
 */
export function createAudioPlayer(audioOutputControl: AudioOutputControl): EstuaryAudioPlayer {
    return new EstuaryAudioPlayer(audioOutputControl);
}





