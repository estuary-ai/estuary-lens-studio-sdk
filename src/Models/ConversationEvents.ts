/** Additive contract events retain their wire casing, including memoryUpdated's existing API. */
export interface ServerError { message: string; error?: string; }
export interface QuotaExceeded { message: string; current: number; limit: number; remaining: number; tier: string; }
export interface SessionRejected { reason: string; cap: number; share_token_id: string; }
export interface ModerationWarning { level: 'warning' | 'terminated'; message: string; }
export interface ModerationFlag { message_id: string; action: 'redacted'; categories: string[]; message: string; }
export interface MemoryData {
    id: string;
    content: string;
    memoryType: string;
    [key: string]: unknown;
}
export interface MemoryUpdated {
    agent_id: string;
    player_id: string;
    memories_extracted: number;
    facts_extracted: number;
    conversation_id: string;
    new_memories: MemoryData[];
    timestamp: string;
}
export interface MotiveUpdated {
    agent_id: string; player_id: string; motive: string; conversation_id: string; timestamp: string;
}
export interface DelegationUpdate {
    status: 'working' | 'completed' | 'authorization_required' | 'input_required' | 'failed' | 'error';
    invocation_id: string;
    message_id: string;
    timestamp: string;
    task?: string;
    result?: unknown;
    error?: string;
    /** Opaque server data only. The SDK does not open URLs or perform authorization. */
    authorization_url?: string;
}
export interface ApiEndpointMedia {
    type: 'image'; url: string; mimeType?: string; title?: string; alt?: string; sourceUrl?: string;
}
export interface ApiEndpointCitation { title?: string; url?: string; }
export interface ApiEndpointResult {
    tool_call_id: string;
    operation: string;
    status: 'completed';
    media: ApiEndpointMedia[];
    citations?: ApiEndpointCitation[];
    message_id: string;
    timestamp: string;
}
export interface TurnMetrics {
    message_id: string;
    status: 'complete' | 'interrupted' | 'error';
    eager: boolean;
    emit_epoch_ms: number;
    endpoint_wait_ms?: number | null;
    speech_end_ms?: number | null;
    memory_ms?: number | null;
    dispatch_context_ms?: number | null;
    queue_wait_ms?: number | null;
    llm_ttft_ms?: number | null;
    llm_total_ms?: number | null;
    tts_engaged_ms?: number | null;
    tts_first_audio_ms?: number | null;
    tts_total_ms?: number | null;
    kb_tool_ms?: number | null;
    kb_tool_source?: string | null;
    server_process_ms?: number | null;
    stt_net_rtt_ms?: number | null;
    llm_net_rtt_ms?: number | null;
    tts_net_rtt_ms?: number | null;
}

export interface ConversationPayloads {
    serverError: ServerError;
    quotaExceeded: QuotaExceeded;
    sessionRejected: SessionRejected;
    moderationWarning: ModerationWarning;
    moderationFlag: ModerationFlag;
    memoryUpdated: MemoryUpdated;
    motiveUpdated: MotiveUpdated;
    delegationUpdate: DelegationUpdate;
    apiEndpointResult: ApiEndpointResult;
    turnMetrics: TurnMetrics;
}
export type ConversationEvent = keyof ConversationPayloads;
export type ConversationEventHandlers = { [K in ConversationEvent]: (data: ConversationPayloads[K]) => void };

/** @internal */
export const conversationWireEvents: Record<string, ConversationEvent> = {
    quota_exceeded: 'quotaExceeded', session_rejected: 'sessionRejected',
    moderation_warning: 'moderationWarning', moderation_flag: 'moderationFlag',
    memory_updated: 'memoryUpdated', motive_updated: 'motiveUpdated',
    delegation_update: 'delegationUpdate', api_endpoint_result: 'apiEndpointResult', turn_metrics: 'turnMetrics',
};

/** Validate the envelope without stripping additive fields or private application data. */
export function isConversationPayload(event: ConversationEvent, data: any): boolean {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    switch (event) {
        case 'quotaExceeded': return typeof data.message === 'string';
        case 'sessionRejected': return typeof data.reason === 'string';
        case 'moderationWarning': return (data.level === 'warning' || data.level === 'terminated') && typeof data.message === 'string';
        case 'moderationFlag': return typeof data.message_id === 'string' && data.action === 'redacted' && typeof data.message === 'string';
        case 'memoryUpdated': return typeof data.agent_id === 'string' && Array.isArray(data.new_memories);
        case 'motiveUpdated': return typeof data.agent_id === 'string' && typeof data.motive === 'string';
        case 'delegationUpdate': return typeof data.invocation_id === 'string' && typeof data.status === 'string';
        case 'apiEndpointResult': return typeof data.message_id === 'string' && typeof data.tool_call_id === 'string' && Array.isArray(data.media);
        case 'turnMetrics': return typeof data.message_id === 'string' && typeof data.status === 'string';
        case 'serverError': return typeof data.message === 'string';
    }
}

export type VoiceMode = 'continuous' | 'push_to_talk';
