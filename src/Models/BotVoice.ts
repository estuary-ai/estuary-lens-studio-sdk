/**
 * Bot voice audio response from the AI character.
 */
export interface BotVoice {
    /** Base64-encoded audio data */
    audio: string;
    
    /** Sample rate of the audio (default: 24000 for ElevenLabs) */
    sampleRate: number;
    
    /** Index of this chunk in a streaming response */
    chunkIndex: number;
    
    /** Unique identifier for this message (for tracking interrupts) */
    messageId: string;
    
    /** Whether this audio is from an interjection */
    isInterjection: boolean;
}

/**
 * Raw bot voice from server (snake_case)
 */
interface BotVoiceJson {
    audio?: string;
    sample_rate?: number;
    sampleRate?: number;
    chunk_index?: number;
    chunkIndex?: number;
    message_id?: string;
    messageId?: string;
    is_interjection?: boolean;
    isInterjection?: boolean;
}

/**
 * Parse BotVoice from JSON object
 */
export function parseBotVoice(json: BotVoiceJson): BotVoice {
    const sampleRate = json.sample_rate ?? json.sampleRate ?? 24000;
    return {
        audio: json.audio || '',
        sampleRate: sampleRate > 0 ? sampleRate : 24000,
        chunkIndex: json.chunk_index ?? json.chunkIndex ?? 0,
        messageId: json.message_id || json.messageId || '',
        isInterjection: json.is_interjection ?? json.isInterjection ?? false
    };
}

/**
 * Format BotVoice as string for logging
 */
export function botVoiceToString(voice: BotVoice): string {
    const audioLength = voice.audio ? Math.floor(voice.audio.length * 0.75) : 0; // Approximate decoded length
    return `BotVoice(AudioLength=~${audioLength} bytes, SampleRate=${voice.sampleRate}, ChunkIndex=${voice.chunkIndex}, MessageId=${voice.messageId})`;
}





