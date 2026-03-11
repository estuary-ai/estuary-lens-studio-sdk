/**
 * Agent/character response from the backend API.
 * Matches the camelCase JSON returned by Agent.to_dict() on the server.
 */
export interface AgentResponse {
    /** Unique agent identifier (UUID) */
    id: string;
    /** Character display name */
    name: string;
    /** Short tagline for the character */
    tagline: string | null;
    /** Character personality description */
    personality: string | null;
    /** Character backstory */
    background: string | null;
    /** Avatar image URL */
    avatar: string | null;
    /** Character appearance description */
    appearance: string | null;
    /** URL to the textured 3D model (GLB) */
    modelUrl: string | null;
    /** URL to the preview 3D model (GLB) */
    modelPreviewUrl: string | null;
    /** 3D model generation status */
    modelStatus: string | null;
    /** URL to the original source image */
    sourceImageUrl: string | null;
    /** Player who created this character */
    playerId: string | null;
    /** Voice preset identifier */
    voicePreset: string | null;
    /** TTS provider name */
    ttsProvider: string;
    /** TTS model name */
    ttsModel: string;
    /** TTS voice identifier */
    ttsVoice: string | null;
    /** LLM provider name */
    llmProvider: string;
    /** LLM model name */
    llmModel: string;
    /** ISO 8601 creation timestamp */
    createdAt: string | null;
    /** ISO 8601 last-updated timestamp */
    updatedAt: string | null;
}

/**
 * Raw agent response JSON from the server.
 * Agent.to_dict() returns camelCase, so we accept both camelCase and snake_case
 * for robustness (e.g., the /api/v1/characters endpoint uses snake_case).
 */
interface AgentResponseJson {
    id?: string;
    name?: string;
    tagline?: string;
    personality?: string;
    background?: string;
    avatar?: string;
    appearance?: string;
    model_url?: string;
    modelUrl?: string;
    model_preview_url?: string;
    modelPreviewUrl?: string;
    model_status?: string;
    modelStatus?: string;
    source_image_url?: string;
    sourceImageUrl?: string;
    player_id?: string;
    playerId?: string;
    voice_preset?: string;
    voicePreset?: string;
    tts_provider?: string;
    ttsProvider?: string;
    tts_model?: string;
    ttsModel?: string;
    tts_voice?: string;
    ttsVoice?: string;
    llm_provider?: string;
    llmProvider?: string;
    llm_model?: string;
    llmModel?: string;
    created_at?: string;
    createdAt?: string;
    updated_at?: string;
    updatedAt?: string;
}

/**
 * Parse an AgentResponse from a raw JSON object.
 * Handles both camelCase (Agent.to_dict()) and snake_case (CharacterResponse) keys.
 */
export function parseAgentResponse(json: AgentResponseJson): AgentResponse {
    return {
        id: json.id || '',
        name: json.name || '',
        tagline: json.tagline || null,
        personality: json.personality || null,
        background: json.background || null,
        avatar: json.avatar || null,
        appearance: json.appearance || null,
        modelUrl: json.modelUrl || json.model_url || null,
        modelPreviewUrl: json.modelPreviewUrl || json.model_preview_url || null,
        modelStatus: json.modelStatus || json.model_status || null,
        sourceImageUrl: json.sourceImageUrl || json.source_image_url || null,
        playerId: json.playerId || json.player_id || null,
        voicePreset: json.voicePreset || json.voice_preset || null,
        ttsProvider: json.ttsProvider || json.tts_provider || '',
        ttsModel: json.ttsModel || json.tts_model || '',
        ttsVoice: json.ttsVoice || json.tts_voice || null,
        llmProvider: json.llmProvider || json.llm_provider || '',
        llmModel: json.llmModel || json.llm_model || '',
        createdAt: json.createdAt || json.created_at || null,
        updatedAt: json.updatedAt || json.updated_at || null,
    };
}

/**
 * Format an AgentResponse as a string for logging.
 */
export function agentResponseToString(response: AgentResponse): string {
    return `AgentResponse(Id=${response.id}, Name="${response.name}", ModelStatus=${response.modelStatus || 'none'})`;
}
