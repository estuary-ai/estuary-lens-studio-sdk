/**
 * Bot text response from the AI character.
 */
export interface BotResponse {
    /** The text content of the response */
    text: string;
    
    /** Whether this is the final/complete response */
    isFinal: boolean;
    
    /** Whether this is a partial (streaming) response */
    partial: boolean;
    
    /** Unique identifier for this message (for tracking interrupts) */
    messageId: string;
    
    /** Index of this chunk in a streaming response */
    chunkIndex: number;
    
    /** Whether this response is an interjection (proactive message during silence) */
    isInterjection: boolean;
}

/**
 * Raw bot response from server (snake_case)
 */
interface BotResponseJson {
    text?: string;
    is_final?: boolean;
    isFinal?: boolean;
    partial?: boolean;
    message_id?: string;
    messageId?: string;
    chunk_index?: number;
    chunkIndex?: number;
    is_interjection?: boolean;
    isInterjection?: boolean;
}

/**
 * Parse BotResponse from JSON object
 */
export function parseBotResponse(json: BotResponseJson): BotResponse {
    const isFinal = json.is_final ?? json.isFinal ?? false;
    return {
        text: json.text || '',
        isFinal: isFinal,
        partial: json.partial ?? !isFinal,
        messageId: json.message_id || json.messageId || '',
        chunkIndex: json.chunk_index ?? json.chunkIndex ?? 0,
        isInterjection: json.is_interjection ?? json.isInterjection ?? false
    };
}

/**
 * Format BotResponse as string for logging
 */
export function botResponseToString(response: BotResponse): string {
    const textPreview = response.text.length > 50 
        ? response.text.substring(0, 50) + '...' 
        : response.text;
    return `BotResponse(Text="${textPreview}", IsFinal=${response.isFinal}, MessageId=${response.messageId})`;
}





