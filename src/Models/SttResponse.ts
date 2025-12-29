/**
 * Speech-to-text response from the server.
 */
export interface SttResponse {
    /** The transcribed text */
    text: string;
    
    /** Whether this is the final transcription */
    isFinal: boolean;
    
    /** Confidence score (0-1) if provided */
    confidence: number;
    
    /** Language detected (if provided) */
    language: string;
}

/**
 * Raw STT response from server (snake_case)
 */
interface SttResponseJson {
    text?: string;
    is_final?: boolean;
    isFinal?: boolean;
    confidence?: number;
    language?: string;
}

/**
 * Parse SttResponse from JSON object
 */
export function parseSttResponse(json: SttResponseJson): SttResponse {
    return {
        text: json.text || '',
        isFinal: json.is_final ?? json.isFinal ?? false,
        confidence: json.confidence ?? 1.0,
        language: json.language || 'en'
    };
}

/**
 * Format SttResponse as string for logging
 */
export function sttResponseToString(response: SttResponse): string {
    const textPreview = response.text.length > 50 
        ? response.text.substring(0, 50) + '...' 
        : response.text;
    return `SttResponse(Text="${textPreview}", IsFinal=${response.isFinal}, Confidence=${response.confidence.toFixed(2)})`;
}





