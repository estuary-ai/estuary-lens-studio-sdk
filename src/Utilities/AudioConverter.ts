/**
 * Utility functions for audio format conversions.
 * Uses Lens Studio's native Base64 class for encoding.
 */

/** Default sample rate for recording (matches Deepgram STT requirements) */
export const DEFAULT_RECORD_SAMPLE_RATE = 16000;

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
