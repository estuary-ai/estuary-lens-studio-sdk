/**
 * Data received when an interrupt signal is sent from the server.
 */
export interface InterruptData {
    /** The message ID that was interrupted (if provided) */
    messageId: string;

    /** Reason for the interrupt (if provided) */
    reason: string;

    /** ISO 8601 timestamp when the server marked the response as interrupted (if provided) */
    interruptedAt: string;
}

/**
 * Raw interrupt data from server (snake_case)
 */
interface InterruptDataJson {
    message_id?: string;
    messageId?: string;
    reason?: string;
    interrupted_at?: string;
    interruptedAt?: string;
}

/**
 * Parse InterruptData from JSON object
 */
export function parseInterruptData(json: InterruptDataJson | null | undefined): InterruptData {
    if (!json) {
        return {
            messageId: '',
            reason: '',
            interruptedAt: ''
        };
    }
    return {
        messageId: json.message_id || json.messageId || '',
        reason: json.reason || '',
        interruptedAt: json.interrupted_at || json.interruptedAt || ''
    };
}

/**
 * Format InterruptData as string for logging
 */
export function interruptDataToString(data: InterruptData): string {
    return `InterruptData(MessageId=${data.messageId}, Reason=${data.reason}, InterruptedAt=${data.interruptedAt})`;
}





