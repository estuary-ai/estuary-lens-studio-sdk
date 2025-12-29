/**
 * Utility class for audio format conversions.
 */

/** Default sample rate for recording (matches Deepgram requirements) */
export const DEFAULT_RECORD_SAMPLE_RATE = 16000;

/** Default sample rate for playback (ElevenLabs output) */
export const DEFAULT_PLAYBACK_SAMPLE_RATE = 24000;

/**
 * Convert Float32Array samples (-1 to 1) to 16-bit PCM bytes.
 * @param floatSamples Audio samples as Float32Array
 * @returns 16-bit PCM audio as Uint8Array
 */
export function floatToPCM16(floatSamples: Float32Array): Uint8Array {
    if (!floatSamples || floatSamples.length === 0) {
        return new Uint8Array(0);
    }

    const bytes = new Uint8Array(floatSamples.length * 2);

    for (let i = 0; i < floatSamples.length; i++) {
        // Clamp to -1 to 1 range
        const sample = Math.max(-1, Math.min(1, floatSamples[i]));

        // Convert to 16-bit signed integer
        const value = Math.floor(sample * 32767);

        // Little-endian byte order
        bytes[i * 2] = value & 0xFF;
        bytes[i * 2 + 1] = (value >> 8) & 0xFF;
    }

    return bytes;
}

/**
 * Convert 16-bit PCM bytes to Float32Array samples.
 * @param pcmBytes 16-bit PCM audio as Uint8Array
 * @returns Audio samples as Float32Array
 */
export function pcm16ToFloat(pcmBytes: Uint8Array): Float32Array {
    if (!pcmBytes || pcmBytes.length === 0) {
        return new Float32Array(0);
    }

    const sampleCount = Math.floor(pcmBytes.length / 2);
    const floatSamples = new Float32Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
        // Little-endian byte order - construct signed 16-bit value
        const low = pcmBytes[i * 2];
        const high = pcmBytes[i * 2 + 1];
        let value = low | (high << 8);
        
        // Convert to signed value
        if (value >= 32768) {
            value -= 65536;
        }

        // Convert to float (-1 to 1)
        floatSamples[i] = value / 32768;
    }

    return floatSamples;
}

/**
 * Resample audio from one sample rate to another using linear interpolation.
 * @param samples Input samples
 * @param sourceSampleRate Original sample rate
 * @param targetSampleRate Desired sample rate
 * @returns Resampled audio
 */
export function resample(
    samples: Float32Array, 
    sourceSampleRate: number, 
    targetSampleRate: number
): Float32Array {
    if (sourceSampleRate === targetSampleRate) {
        return samples;
    }

    const ratio = targetSampleRate / sourceSampleRate;
    const newLength = Math.round(samples.length * ratio);
    const resampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
        const sourceIndex = i / ratio;
        const index0 = Math.floor(sourceIndex);
        const index1 = Math.min(index0 + 1, samples.length - 1);
        const t = sourceIndex - index0;

        // Linear interpolation
        resampled[i] = samples[index0] * (1 - t) + samples[index1] * t;
    }

    return resampled;
}

/**
 * Convert stereo audio to mono by averaging channels.
 * @param stereoSamples Interleaved stereo samples
 * @returns Mono samples
 */
export function stereoToMono(stereoSamples: Float32Array): Float32Array {
    if (!stereoSamples || stereoSamples.length === 0) {
        return new Float32Array(0);
    }

    const monoLength = Math.floor(stereoSamples.length / 2);
    const monoSamples = new Float32Array(monoLength);

    for (let i = 0; i < monoLength; i++) {
        monoSamples[i] = (stereoSamples[i * 2] + stereoSamples[i * 2 + 1]) / 2;
    }

    return monoSamples;
}

/**
 * Calculate the RMS volume of audio samples.
 * @param samples Audio samples
 * @returns RMS volume (0 to 1)
 */
export function calculateRMS(samples: Float32Array): number {
    if (!samples || samples.length === 0) {
        return 0;
    }

    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
    }

    return Math.sqrt(sum / samples.length);
}

/**
 * Calculate the dB level from RMS.
 * @param rms RMS value
 * @returns dB level (typically -60 to 0)
 */
export function rmsToDecibels(rms: number): number {
    if (rms <= 0) {
        return -60;
    }

    return 20 * Math.log10(rms);
}

/**
 * Normalize audio samples to a target peak level.
 * @param samples Input samples
 * @param targetPeak Target peak level (0 to 1)
 * @returns Normalized samples
 */
export function normalize(samples: Float32Array, targetPeak: number = 0.95): Float32Array {
    if (!samples || samples.length === 0) {
        return new Float32Array(0);
    }

    // Find current peak
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) {
            peak = abs;
        }
    }

    if (peak === 0) {
        return samples;
    }

    // Calculate gain
    const gain = targetPeak / peak;

    // Apply gain
    const normalized = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        normalized[i] = samples[i] * gain;
    }

    return normalized;
}





