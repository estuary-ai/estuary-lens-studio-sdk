/**
 * Response from the model status polling endpoint.
 * Matches GET /api/v1/characters/{agentId}/model response.
 */
export interface ModelStatusResponse {
    /** Current model generation status */
    modelStatus: string;
    rigged?: boolean;
    animations?: string[];
    /** URL to the preview 3D model (GLB) */
    modelPreviewUrl: string | null;
    /** URL to the textured 3D model (GLB) */
    modelUrl: string | null;
    /** URL to the model thumbnail image */
    thumbnailUrl: string | null;
    /** Overall generation progress (0-100) */
    progress: number;
}

/**
 * Raw model status JSON from the server.
 */
interface ModelStatusResponseJson {
    modelStatus?: string;
    rigged?: boolean;
    animations?: string[];
    model_status?: string;
    modelPreviewUrl?: string;
    model_preview_url?: string;
    modelUrl?: string;
    model_url?: string;
    thumbnailUrl?: string;
    thumbnail_url?: string;
    progress?: number;
}

/**
 * Parse a ModelStatusResponse from a raw JSON object.
 */
export function parseModelStatusResponse(json: ModelStatusResponseJson): ModelStatusResponse {
    return {
        modelStatus: json.modelStatus || json.model_status || '',
        rigged: json.rigged === true,
        animations: Array.isArray(json.animations) ? json.animations.filter(name => typeof name === 'string') : [],
        modelPreviewUrl: json.modelPreviewUrl || json.model_preview_url || null,
        modelUrl: json.modelUrl || json.model_url || null,
        thumbnailUrl: json.thumbnailUrl || json.thumbnail_url || null,
        progress: json.progress ?? 0,
    };
}

/**
 * Check if the model is still being generated.
 */
export function isModelInProgress(response: ModelStatusResponse): boolean {
    return ['posing', 'generating', 'preview_ready', 'rig_checking', 'rigging', 'animating'].includes(response.modelStatus);
}

/**
 * Check if the model generation completed successfully.
 */
export function isModelCompleted(response: ModelStatusResponse): boolean {
    return response.modelStatus === 'completed';
}

/**
 * Check if the model generation failed completely.
 */
export function isModelFailed(response: ModelStatusResponse): boolean {
    return response.modelStatus === 'failed' || (['rig_failed', 'animation_failed'].includes(response.modelStatus) && !response.modelUrl);
}

/**
 * Check if the model texture step failed (preview model is still usable).
 */
export function isModelTextureFailed(response: ModelStatusResponse): boolean {
    return response.modelStatus === 'texture_failed';
}

/**
 * Format a ModelStatusResponse as a string for logging.
 */
export function modelStatusResponseToString(response: ModelStatusResponse): string {
    return `ModelStatusResponse(Status=${response.modelStatus}, Progress=${response.progress}%, ModelUrl=${response.modelUrl || 'none'})`;
}

/** Rigging failures can still deliver a usable static model. */
export function isModelPartialSuccess(response: ModelStatusResponse): boolean {
    return ['rig_failed', 'animation_failed'].includes(response.modelStatus) && !!response.modelUrl;
}
