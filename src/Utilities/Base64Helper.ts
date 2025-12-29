/**
 * Utility class for Base64 encoding/decoding operations.
 */

import { floatToPCM16, pcm16ToFloat } from './AudioConverter';

// Base64 character set
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encode bytes to Base64 string.
 * @param data Byte array to encode
 * @returns Base64 encoded string
 */
export function encode(data: Uint8Array): string {
    if (!data || data.length === 0) {
        return '';
    }

    let result = '';
    const len = data.length;

    for (let i = 0; i < len; i += 3) {
        const b1 = data[i];
        const b2 = i + 1 < len ? data[i + 1] : 0;
        const b3 = i + 2 < len ? data[i + 2] : 0;

        const c1 = b1 >> 2;
        const c2 = ((b1 & 0x03) << 4) | (b2 >> 4);
        const c3 = ((b2 & 0x0F) << 2) | (b3 >> 6);
        const c4 = b3 & 0x3F;

        result += BASE64_CHARS[c1];
        result += BASE64_CHARS[c2];
        result += i + 1 < len ? BASE64_CHARS[c3] : '=';
        result += i + 2 < len ? BASE64_CHARS[c4] : '=';
    }

    return result;
}

/**
 * Decode Base64 string to bytes.
 * @param base64 Base64 encoded string
 * @returns Decoded byte array
 */
export function decode(base64: string): Uint8Array {
    if (!base64 || base64.length === 0) {
        return new Uint8Array(0);
    }

    // Remove padding and calculate output length
    let cleanBase64 = base64.replace(/=+$/, '');
    const len = cleanBase64.length;
    const outputLen = Math.floor(len * 3 / 4);
    const result = new Uint8Array(outputLen);

    let j = 0;
    for (let i = 0; i < len; i += 4) {
        const c1 = BASE64_CHARS.indexOf(cleanBase64[i]);
        const c2 = i + 1 < len ? BASE64_CHARS.indexOf(cleanBase64[i + 1]) : 0;
        const c3 = i + 2 < len ? BASE64_CHARS.indexOf(cleanBase64[i + 2]) : 0;
        const c4 = i + 3 < len ? BASE64_CHARS.indexOf(cleanBase64[i + 3]) : 0;

        result[j++] = (c1 << 2) | (c2 >> 4);
        if (j < outputLen) {
            result[j++] = ((c2 & 0x0F) << 4) | (c3 >> 2);
        }
        if (j < outputLen) {
            result[j++] = ((c3 & 0x03) << 6) | c4;
        }
    }

    return result;
}

/**
 * Try to decode Base64 string to bytes.
 * @param base64 Base64 encoded string
 * @returns Object with success flag and result
 */
export function tryDecode(base64: string): { success: boolean; result: Uint8Array } {
    try {
        const result = decode(base64);
        return { success: true, result };
    } catch {
        return { success: false, result: new Uint8Array(0) };
    }
}

/**
 * Encode string to Base64.
 * @param text String to encode
 * @returns Base64 encoded string
 */
export function encodeString(text: string): string {
    if (!text || text.length === 0) {
        return '';
    }

    // Convert string to UTF-8 bytes manually (Lens Studio compatible)
    const bytes = stringToUtf8Bytes(text);
    return encode(bytes);
}

/**
 * Decode Base64 to string.
 * @param base64 Base64 encoded string
 * @returns Decoded string
 */
export function decodeString(base64: string): string {
    const bytes = decode(base64);
    if (bytes.length === 0) {
        return '';
    }

    // Convert UTF-8 bytes to string manually (Lens Studio compatible)
    return utf8BytesToString(bytes);
}

/**
 * Convert string to UTF-8 bytes (Lens Studio compatible).
 */
function stringToUtf8Bytes(str: string): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
        let charCode = str.charCodeAt(i);
        if (charCode < 0x80) {
            bytes.push(charCode);
        } else if (charCode < 0x800) {
            bytes.push(0xC0 | (charCode >> 6));
            bytes.push(0x80 | (charCode & 0x3F));
        } else if (charCode < 0xD800 || charCode >= 0xE000) {
            bytes.push(0xE0 | (charCode >> 12));
            bytes.push(0x80 | ((charCode >> 6) & 0x3F));
            bytes.push(0x80 | (charCode & 0x3F));
        } else {
            // Surrogate pair
            i++;
            charCode = 0x10000 + (((charCode & 0x3FF) << 10) | (str.charCodeAt(i) & 0x3FF));
            bytes.push(0xF0 | (charCode >> 18));
            bytes.push(0x80 | ((charCode >> 12) & 0x3F));
            bytes.push(0x80 | ((charCode >> 6) & 0x3F));
            bytes.push(0x80 | (charCode & 0x3F));
        }
    }
    return new Uint8Array(bytes);
}

/**
 * Convert UTF-8 bytes to string (Lens Studio compatible).
 */
function utf8BytesToString(bytes: Uint8Array): string {
    let result = '';
    let i = 0;
    while (i < bytes.length) {
        const byte1 = bytes[i++];
        if (byte1 < 0x80) {
            result += String.fromCharCode(byte1);
        } else if ((byte1 & 0xE0) === 0xC0) {
            const byte2 = bytes[i++];
            result += String.fromCharCode(((byte1 & 0x1F) << 6) | (byte2 & 0x3F));
        } else if ((byte1 & 0xF0) === 0xE0) {
            const byte2 = bytes[i++];
            const byte3 = bytes[i++];
            result += String.fromCharCode(((byte1 & 0x0F) << 12) | ((byte2 & 0x3F) << 6) | (byte3 & 0x3F));
        } else if ((byte1 & 0xF8) === 0xF0) {
            const byte2 = bytes[i++];
            const byte3 = bytes[i++];
            const byte4 = bytes[i++];
            const codePoint = ((byte1 & 0x07) << 18) | ((byte2 & 0x3F) << 12) | ((byte3 & 0x3F) << 6) | (byte4 & 0x3F);
            // Convert to surrogate pair
            const offset = codePoint - 0x10000;
            result += String.fromCharCode(0xD800 | (offset >> 10));
            result += String.fromCharCode(0xDC00 | (offset & 0x3FF));
        }
    }
    return result;
}

/**
 * Encode Float32Array audio samples to Base64 (as 16-bit PCM).
 * @param samples Audio samples
 * @returns Base64 encoded PCM16 audio
 */
export function encodeAudio(samples: Float32Array): string {
    const pcmBytes = floatToPCM16(samples);
    return encode(pcmBytes);
}

/**
 * Decode Base64 audio (16-bit PCM) to Float32Array samples.
 * @param base64 Base64 encoded PCM16 audio
 * @returns Float audio samples
 */
export function decodeAudio(base64: string): Float32Array {
    const pcmBytes = decode(base64);
    return pcm16ToFloat(pcmBytes);
}

/**
 * Check if a string is valid Base64.
 * @param base64 String to check
 * @returns True if valid Base64
 */
export function isValidBase64(base64: string): boolean {
    if (!base64 || base64.length === 0) {
        return false;
    }

    // Check length (must be multiple of 4)
    if (base64.length % 4 !== 0) {
        return false;
    }

    // Check characters
    const validChars = /^[A-Za-z0-9+/]*={0,2}$/;
    return validChars.test(base64);
}

/**
 * Get the decoded byte length without actually decoding.
 * @param base64 Base64 string
 * @returns Estimated decoded length in bytes
 */
export function getDecodedLength(base64: string): number {
    if (!base64 || base64.length === 0) {
        return 0;
    }

    let padding = 0;
    if (base64.endsWith('==')) {
        padding = 2;
    } else if (base64.endsWith('=')) {
        padding = 1;
    }

    return Math.floor(base64.length * 3 / 4) - padding;
}





