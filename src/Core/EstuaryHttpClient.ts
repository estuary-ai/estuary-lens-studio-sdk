/**
 * HTTP client for Estuary REST API endpoints on Lens Studio / Spectacles.
 *
 * Uses InternetModule.performHttpRequest and RemoteServiceHttpRequest for all
 * HTTP operations. Auth credentials are sent via X-API-Key and X-Player-Id
 * headers rather than query parameters.
 *
 * Because this Spectacles request path uses string bodies, image uploads use
 * JSON+base64 encoding.
 */

import { DelayScheduler, CancelDelay, scheduleDelay } from '../Utilities/LensScheduler';
import { EstuaryConfig } from './EstuaryConfig';
import { getInternetModule } from './EstuaryClient';
import { AgentResponse, parseAgentResponse } from '../Models/AgentResponse';
import {
    ModelStatusResponse,
    parseModelStatusResponse,
    isModelCompleted,
    isModelFailed,
    isModelTextureFailed,
    isModelPartialSuccess,
} from '../Models/ModelStatusResponse';
import { CharacterListResponse, parseCharacterListResponse } from '../Models/CharacterListResponse';

/**
 * HTTP client for Estuary REST API operations from Lens Studio.
 *
 * Provides methods for:
 * - Uploading images to create characters (JSON+base64)
 * - Polling 3D model generation status with exponential backoff
 * - Listing characters via paginated GET
 *
 * Uses Lens Studio's InternetModule HTTP API.
 */
/**
 * SDK version, sent to the gateway as `X-Estuary-Client: estuary-lens-studio-sdk/<version>`.
 * This is the single source of truth: Lens Studio has no package manifest with a version
 * (package.native's version fields are zeroed), so set it to the release tag when tagging.
 */
export const ESTUARY_SDK_VERSION = '0.4.0';

/** Optional parameters for image-to-character generation. */
export interface ImageToCharacterOptions {
    /** Custom appearance description (replaces default, char limit applied automatically) */
    appearancePrompt?: string;
    /** Custom voice description (replaces default, char limit applied automatically) */
    voicePrompt?: string;
    /** Custom persona/personality description (replaces default, char limit applied automatically) */
    personaPrompt?: string;
    /** Internal resume hook: reuse a key from ImageUploadFailedError for the same image. */
    _idempotencyKeyOverride?: string;
}

/** A transient image upload exhausted its retry budget. Persist the key to resume safely. */
export class ImageUploadFailedError extends Error {
    readonly idempotency_key: string;
    readonly attempts: number;
    readonly last_status: number | null;
    readonly last_response_text: string | null;

    constructor(key: string, attempts: number, status: number | null, responseText: string | null) {
        super(`Image upload failed after ${attempts} attempts (idempotency_key=${key})`);
        this.name = 'ImageUploadFailedError';
        this.idempotency_key = key;
        this.attempts = attempts;
        this.last_status = status;
        this.last_response_text = responseText;
    }
}

const UPLOAD_MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 30000;
const UPLOAD_REQUEST_TIMEOUT_MS = 35000;

/** Prefer native UUIDs; the fallback is only an idempotency identifier, never a credential. */
function imageUploadKey(): string {
    // @ts-ignore Available on newer Lens runtimes; feature-detected for older targets.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        // @ts-ignore See above.
        return crypto.randomUUID().replace(/-/g, '');
    }
    let key = '';
    for (let i = 0; i < 32; i++) {
        const digit = i === 12 ? 4 : i === 16 ? 8 + Math.floor(Math.random() * 4) : Math.floor(Math.random() * 16);
        key += digit.toString(16);
    }
    return key;
}

function retryAfterMs(value: string | null): number | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        return Math.min(Number(trimmed) * 1000, RETRY_AFTER_CAP_MS);
    }
    const date = Date.parse(trimmed);
    return isNaN(date) ? null : Math.min(Math.max(0, date - Date.now()), RETRY_AFTER_CAP_MS);
}

function retryDelayMs(attempt: number): number {
    return (attempt === 1 ? 1000 : 2000) * (0.75 + Math.random() * 0.5);
}

/** Bound diagnostics to 512 UTF-8 bytes without cutting a surrogate pair. */
function responsePrefix(value: string): string {
    let bytes = 0;
    let end = 0;
    while (end < value.length) {
        const code = value.charCodeAt(end);
        const pair = code >= 0xd800 && code <= 0xdbff && end + 1 < value.length
            && value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff;
        const width = pair ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
        if (bytes + width > 512) break;
        bytes += width;
        end += pair ? 2 : 1;
    }
    return value.substring(0, end);
}

export class EstuaryHttpClient {
    private serverUrl: string;
    private apiKey: string;
    private playerId: string;
    private debugLogging: boolean;

    /** Whether polling is currently active */
    private _pollActive: boolean = false;
    private _pollGeneration = 0;

    constructor(config: EstuaryConfig, private scheduler: DelayScheduler = scheduleDelay) {
        this.serverUrl = (config.serverUrl || '').replace(/\/$/, '');
        this.apiKey = config.apiKey || '';
        this.playerId = config.playerId || '';
        this.debugLogging = config.debugLogging || false;
    }

    // ---- Public API ----

    /**
     * Upload a base64-encoded image to create a new character.
     * POST /api/v1/characters/from-image with Content-Type: application/json.
     * Body fields are camelCase (the route rejects unknown fields). Returns 201 with the
     * v1 CharacterResponse shape, which parseAgentResponse already maps.
     *
     * @param imageBase64 Base64-encoded image data (no data URI prefix)
     * @param mimeType MIME type of the image (e.g., "image/jpeg", "image/png")
     * @param options Optional prompt overrides; _idempotencyKeyOverride resumes a failed upload
     * @returns The created AgentResponse
     */
    async uploadImageToCharacter(imageBase64: string, mimeType: string, options?: ImageToCharacterOptions): Promise<AgentResponse> {
        const key = options?._idempotencyKeyOverride || imageUploadKey();
        if (key.length > 255) throw new Error('Idempotency key must be at most 255 characters');
        const url = this.getHttpBaseUrl() + '/api/v1/characters/from-image';
        const payload: Record<string, string> = {
            image: imageBase64,
            mimeType: mimeType,
        };
        if (options?.appearancePrompt) {
            payload.appearancePrompt = options.appearancePrompt;
        }
        if (options?.voicePrompt) {
            payload.voicePrompt = options.voicePrompt;
        }
        if (options?.personaPrompt) {
            payload.personaPrompt = options.personaPrompt;
        }
        const body = JSON.stringify(payload);

        this.log(`Uploading image to character (${mimeType}, ${Math.round(imageBase64.length / 1024)}KB base64)`);

        let lastStatus: number | null = null;
        let lastText: string | null = null;
        for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
            let result: { status: number; body: string; retryAfter: string | null };
            try {
                result = await this.fetchJson('POST', url, body, { 'Idempotency-Key': key }, UPLOAD_REQUEST_TIMEOUT_MS);
            } catch (error: any) {
                // Preserve the last actual HTTP response when a later transport attempt fails.
                if (attempt === UPLOAD_MAX_ATTEMPTS) {
                    throw new ImageUploadFailedError(key, attempt, lastStatus, lastText);
                }
                this.log(`Upload attempt ${attempt} transport failure: ${String(error)}`);
                await this.waitForRetry(retryDelayMs(attempt));
                continue;
            }

            const { status, body: responseBody, retryAfter } = result;
            if (status > 0) {
                lastStatus = status;
                lastText = responsePrefix(responseBody);
            }
            if (status >= 200 && status < 300) {
                const agent = parseAgentResponse(JSON.parse(responseBody));
                this.log(`Character created: ${agent.id} "${agent.name}"`);
                return agent;
            }
            const retryable = status <= 0 || status === 429 || status === 502 || status === 503 || status === 504;
            if (!retryable) {
                // A timed-out first request may still be creating the character.
                // The server returns 409 while its idempotency sentinel is pending;
                // expose the key so the caller can safely resume later.
                if (status === 409) throw new ImageUploadFailedError(key, attempt, lastStatus, lastText);
                throw new Error(`Upload failed with status ${status}: ${responseBody.substring(0, 200)}`);
            }
            if (attempt === UPLOAD_MAX_ATTEMPTS) {
                throw new ImageUploadFailedError(key, attempt, lastStatus, lastText);
            }
            const delay = status === 429 ? retryAfterMs(retryAfter) : null;
            await this.waitForRetry(delay === null ? retryDelayMs(attempt) : delay);
        }
        throw new ImageUploadFailedError(key, UPLOAD_MAX_ATTEMPTS, lastStatus, lastText);
    }

    /**
     * Get the current model generation status for an agent.
     * GET /api/v1/characters/{agentId}/model.
     *
     * @param agentId Agent UUID to check
     * @returns The ModelStatusResponse
     */
    async getModelStatus(agentId: string): Promise<ModelStatusResponse> {
        const url = this.getHttpBaseUrl() + '/api/v1/characters/' + agentId + '/model';

        const { status, body: responseBody } = await this.fetchJson('GET', url);

        if (status >= 200 && status < 300) {
            const json = JSON.parse(responseBody);
            return parseModelStatusResponse(json);
        } else {
            throw new Error(`Model status request failed with status ${status}: ${responseBody.substring(0, 200)}`);
        }
    }

    /**
     * Trigger 3D model generation for an existing agent.
     * POST /api/v1/characters/{agentId}/model. Returns 202 {characterId, modelStatus, rigged}.
     *
     * Also serves as retry when previous generation failed.
     * Throws on 409 if generation already in progress.
     *
     * @param agentId Agent UUID to generate model for
     * @returns The initial ModelStatusResponse with modelStatus "generating"
     */
    async generateModel(agentId: string, options?: { rigged?: boolean }): Promise<ModelStatusResponse> {
        const url = this.getHttpBaseUrl() + '/api/v1/characters/' + agentId + '/model';
        const body = JSON.stringify(options?.rigged === undefined ? {} : { rigged: options.rigged });

        this.log(`Triggering model generation for agent ${agentId}`);

        const { status, body: responseBody } = await this.fetchJson('POST', url, body);

        if (status >= 200 && status < 300) {
            const json = JSON.parse(responseBody);
            return parseModelStatusResponse(json);
        } else {
            throw new Error(`Generate model failed with status ${status}: ${responseBody.substring(0, 200)}`);
        }
    }

    /**
     * Poll model generation status with exponential backoff until completion or failure.
     *
     * @param agentId Agent UUID to poll
     * @param onStatusChanged Called whenever modelStatus or progress changes
     * @param onCompleted Called when model generation completes (including texture_failed, which has a usable preview)
     * @param onError Called when model generation fails or a network error occurs
     * @param initialIntervalMs Initial polling interval in milliseconds (default: 2000)
     * @param maxIntervalMs Maximum polling interval in milliseconds (default: 10000)
     * @param maxDurationMs Maximum total polling duration in milliseconds (default: 300000 = 5 minutes)
     */
    pollModelStatus(
        agentId: string,
        onStatusChanged: (status: ModelStatusResponse) => void,
        onCompleted: (status: ModelStatusResponse) => void,
        onError: (error: string) => void,
        initialIntervalMs: number = 2000,
        maxIntervalMs: number = 10000,
        maxDurationMs: number = 300000
    ): void {
        this.stopPolling();
        this._pollActive = true;
        const generation = this._pollGeneration;

        let intervalMs = initialIntervalMs;
        let lastStatus = '';
        let lastProgress = -1;
        const startTime = Date.now();

        const doPoll = async (): Promise<void> => {
            if (!this._pollActive || generation !== this._pollGeneration) {
                return;
            }

            if (Date.now() - startTime > maxDurationMs) {
                this._pollActive = false;
                onError('Model generation timed out after ' + Math.round(maxDurationMs / 1000) + 's');
                return;
            }

            try {
                const status = await this.getModelStatus(agentId);

                if (!this._pollActive || generation !== this._pollGeneration) {
                    return;
                }

                // Notify on status or progress change
                if (status.modelStatus !== lastStatus || status.progress !== lastProgress) {
                    lastStatus = status.modelStatus;
                    lastProgress = status.progress;
                    onStatusChanged(status);
                }
                // The application may cancel or replace polling from its status callback.
                if (!this._pollActive || generation !== this._pollGeneration) return;

                // Terminal states
                if (isModelCompleted(status) || isModelTextureFailed(status) || isModelPartialSuccess(status)) {
                    this._pollActive = false;
                    onCompleted(status);
                    return;
                }

                if (isModelFailed(status)) {
                    this._pollActive = false;
                    onError('Model generation failed with status: ' + status.modelStatus);
                    return;
                }

                // Schedule next poll with exponential backoff
                intervalMs = Math.min(intervalMs * 1.5, maxIntervalMs);
                this.scheduleDelayedCallback(() => { doPoll(); }, intervalMs);

            } catch (error: any) {
                if (!this._pollActive || generation !== this._pollGeneration) {
                    return;
                }
                this._pollActive = false;
                onError(error.message || String(error));
            }
        };

        // Start first poll after initial interval
        this.scheduleDelayedCallback(() => { doPoll(); }, intervalMs);
    }

    /**
     * Stop any active model status polling.
     */
    stopPolling(): void {
        this._pollGeneration++;
        this._pollActive = false;
    }

    /**
     * List characters for the authenticated user.
     * GET /api/v1/characters with optional pagination.
     *
     * @param limit Maximum number of results (default: 20)
     * @param offset Offset into the result set (default: 0)
     * @returns The paginated CharacterListResponse
     */
    async getCharacters(limit: number = 20, offset: number = 0): Promise<CharacterListResponse> {
        const url = this.getHttpBaseUrl() + '/api/v1/characters?limit=' + limit + '&offset=' + offset;

        const { status, body: responseBody } = await this.fetchJson('GET', url);

        if (status >= 200 && status < 300) {
            const json = JSON.parse(responseBody);
            const response = parseCharacterListResponse(json);
            this.log(`Characters listed: ${response.characters.length} of ${response.total}`);
            return response;
        } else {
            throw new Error(`Character list request failed with status ${status}: ${responseBody.substring(0, 200)}`);
        }
    }

    /**
     * Start a stateless 2-character Encounter via POST /api/v1/encounters.
     *
     * The server runs the conversation in a background task and streams
     * alternating turns over /sdk Socket.IO. The caller must subscribe
     * to those events via ``EstuaryClient.subscribeEncounter()`` (or
     * ``EstuaryManager.subscribeEncounter()``) using the returned
     * ``encounterId``. See SDK_CONTRACT.md §REST API — Encounter for the
     * full contract.
     *
     * @param req Request body. ``maxTurns`` defaults to 6 client-side and
     *            is hard-capped at 20 server-side (HTTP 422 if exceeded).
     * @returns ``{encounterId}``
     */
    async startEncounter(req: {
        characterAId: string;
        characterBId: string;
        prompt: string;
        maxTurns?: number;
        voice?: boolean;
        starter?: 'a' | 'b';
    }): Promise<{ encounterId: string }> {
        const url = this.getHttpBaseUrl() + '/api/v1/encounters';
        const body = JSON.stringify({
            characterAId: req.characterAId,
            characterBId: req.characterBId,
            prompt: req.prompt,
            maxTurns: req.maxTurns ?? 6,
            voice: req.voice ?? false,
            starter: req.starter ?? 'a',
        });

        this.log(
            `Starting encounter: a=${req.characterAId} b=${req.characterBId} ` +
            `maxTurns=${req.maxTurns ?? 6} voice=${req.voice ?? false}`
        );

        const { status, body: responseBody } = await this.fetchJson('POST', url, body);

        if (status >= 200 && status < 300) {
            const json = JSON.parse(responseBody);
            const encounterId: string = json.encounterId || json.encounter_id || '';
            if (!encounterId) {
                throw new Error('startEncounter: server returned 2xx but no encounterId');
            }
            this.log(`Encounter started: ${encounterId}`);
            return { encounterId };
        } else {
            throw new Error(
                `startEncounter failed (${status}): ` +
                responseBody.substring(0, 200)
            );
        }
    }

    /**
     * Get a single character by ID.
     * GET /api/v1/characters/{characterId}.
     *
     * @param characterId Character/agent UUID
     * @returns The AgentResponse
     */
    async getCharacter(characterId: string): Promise<AgentResponse> {
        const url = this.getHttpBaseUrl() + '/api/v1/characters/' + characterId;

        const { status, body: responseBody } = await this.fetchJson('GET', url);

        if (status >= 200 && status < 300) {
            const json = JSON.parse(responseBody);
            const agent = parseAgentResponse(json);
            this.log(`Character loaded: ${agent.id} "${agent.name}"`);
            return agent;
        } else {
            throw new Error(`Get character failed with status ${status}: ${responseBody.substring(0, 200)}`);
        }
    }

    /**
     * Download a GLB model from a URL and instantiate it into the Lens Studio scene.
     *
     * Uses the three-step Lens Studio pipeline:
     * 1. InternetModule.makeResourceFromUrl() -> DynamicResource
     * 2. RemoteMediaModule.loadResourceAsGltfAsset() -> GltfAsset
     * 3. GltfAsset.tryInstantiateAsync() -> SceneObject
     *
     * Requires setInternetModule() to have been called before use.
     * Tripo GLBs include embedded PBR materials/textures; the material parameter
     * is a Lens Studio API requirement (GLB materials take precedence).
     *
     * @param url Full HTTPS URL to the GLB file, or a path relative to server
     * @param parent SceneObject to parent the instantiated model under
     * @param material A PBR Material from the Lens Studio scene (required by API)
     * @param onProgress Optional callback for instantiation progress (0-1)
     * @param gltfSettings Optional GltfSettings; defaults to convertMetersToCentimeters=true
     * @returns Promise resolving to the instantiated SceneObject
     */
    async downloadAndInstantiateGlb(
        url: string,
        parent: any,
        material: any,
        onProgress?: (progress: number) => void,
        gltfSettings?: any
    ): Promise<any> {
        const resolvedUrl = url.startsWith('/') ? this.getHttpBaseUrl() + url : url;

        const internetModule = getInternetModule();
        if (!internetModule) {
            throw new Error('InternetModule not available. Call setInternetModule() before downloading GLB models.');
        }

        this.log('Downloading GLB from: ' + resolvedUrl.substring(0, 100));

        // Step 1: Create DynamicResource from URL
        const resource = internetModule.makeResourceFromUrl(resolvedUrl);

        // Steps 2+3: Load as GltfAsset then instantiate into scene
        return new Promise<any>((resolve, reject) => {
            // @ts-ignore - Lens Studio module system
            const remoteMediaModule = require('LensStudio:RemoteMediaModule');

            remoteMediaModule.loadResourceAsGltfAsset(
                resource,
                (gltfAsset: any) => {
                    this.log('GLB loaded as GltfAsset, instantiating...');
                    this.log('GltfAsset name: ' + (gltfAsset.name || 'unnamed'));
                    this.log('GltfAsset type: ' + (gltfAsset.getTypeName ? gltfAsset.getTypeName() : typeof gltfAsset));

                    // Build GltfSettings with sensible defaults
                    let settings = gltfSettings;
                    if (!settings) {
                        // @ts-ignore - Lens Studio global
                        if (typeof GltfSettings !== 'undefined') {
                            // @ts-ignore
                            settings = GltfSettings.create();
                            settings.convertMetersToCentimeters = true;
                            this.log('GltfSettings created with convertMetersToCentimeters=true');
                        } else {
                            this.log('GltfSettings not available');
                        }
                    }

                    // Try sync with settings first (applies unit conversion)
                    try {
                        this.log('Trying tryInstantiateWithSetting (sync)...');
                        const sceneObject = settings
                            ? gltfAsset.tryInstantiateWithSetting(parent, material, settings)
                            : gltfAsset.tryInstantiate(parent, material);
                        if (sceneObject) {
                            this.log('GLB instantiated successfully (sync)');
                            resolve(sceneObject);
                            return;
                        }
                        this.log('Sync instantiate returned null, trying async...');
                    } catch (syncErr: any) {
                        this.log('Sync instantiate failed: ' + (syncErr.message || syncErr) + ', trying async...');
                    }

                    gltfAsset.tryInstantiateAsync(
                        parent,
                        material,
                        (sceneObject: any) => {
                            this.log('GLB instantiated successfully (async)');
                            resolve(sceneObject);
                        },
                        (error: string) => {
                            reject(new Error('GLB instantiation failed for ' + resolvedUrl.substring(0, 80) + ': ' + error));
                        },
                        (progress: number) => {
                            if (onProgress) {
                                onProgress(progress);
                            }
                        },
                        settings
                    );
                },
                (error: string) => {
                    reject(new Error('GLB download failed for ' + resolvedUrl.substring(0, 80) + ': ' + error));
                }
            );
        });
    }

    // ---- Private helpers ----

    /**
     * Perform an HTTP request using RemoteServiceHttpRequest.
     *
     * @param method HTTP method ('GET' or 'POST')
     * @param url Full request URL
     * @param body Request body (for POST) or undefined (for GET)
     * @returns Object with status code and response body text
     */
    private async fetchJson(method: 'GET' | 'POST', url: string, body?: string, extraHeaders?: Record<string, string>, timeoutMs?: number): Promise<{ status: number; body: string; retryAfter: string | null }> {

        const internetModule = getInternetModule();
        if (!internetModule) {
            throw new Error('InternetModule not available. Call setInternetModule() first.');
        }

        return new Promise<{ status: number; body: string; retryAfter: string | null }>((resolve, reject) => {
            let settled = false;
            let cancelTimeout: CancelDelay | void;
            try {
                // @ts-ignore - Lens Studio global RemoteServiceHttpRequest
                const request = RemoteServiceHttpRequest.create();
                request.url = url;
                // @ts-ignore - Lens Studio HttpRequestMethod enum
                request.method = method === 'POST'
                    ? RemoteServiceHttpRequest.HttpRequestMethod.Post
                    : RemoteServiceHttpRequest.HttpRequestMethod.Get;

                // Set headers via setHeader()
                if (method === 'POST') {
                    request.setHeader('Content-Type', 'application/json');
                }
                if (this.apiKey) {
                    request.setHeader('X-API-Key', this.apiKey);
                }
                if (this.playerId) {
                    request.setHeader('X-Player-Id', this.playerId);
                }
                // Skip ngrok free-tier browser interstitial
                request.setHeader('ngrok-skip-browser-warning', 'true');
                request.setHeader('User-Agent', 'EstuarySDK/1.0');
                // Identifies this SDK and version to the gateway (REST only, never on the WebSocket)
                request.setHeader('X-Estuary-Client', 'estuary-lens-studio-sdk/' + ESTUARY_SDK_VERSION);
                if (extraHeaders) {
                    for (const name in extraHeaders) request.setHeader(name, extraHeaders[name]);
                }

                if (body) {
                    request.body = body;
                }

                if (timeoutMs) {
                    cancelTimeout = this.scheduleDelayedCallback(() => {
                        if (!settled) {
                            settled = true;
                            reject(new Error(`HTTP request timed out after ${timeoutMs}ms`));
                        }
                    }, timeoutMs);
                }
                internetModule.performHttpRequest(request, (response: any) => {
                    if (settled) return;
                    if (cancelTimeout) cancelTimeout();
                    try {
                        const statusCode = response?.statusCode ?? 0;
                        const responseBody = response?.body || '';
                        let retryAfter: string | null = null;
                        if (statusCode === 429 && typeof response?.getHeader === 'function') {
                            try {
                                retryAfter = response.getHeader('Retry-After') || null;
                            } catch {
                                // Lens Studio throws when an optional header is absent.
                            }
                        }
                        settled = true;
                        resolve({ status: statusCode, body: responseBody, retryAfter });
                    } catch (error: any) {
                        settled = true;
                        reject(new Error('HTTP response failed: ' + (error.message || String(error))));
                    }
                });
            } catch (error: any) {
                if (cancelTimeout) cancelTimeout();
                if (!settled) {
                    settled = true;
                    reject(new Error('HTTP request failed: ' + (error.message || String(error))));
                }
            }
        });
    }

    private waitForRetry(delayMs: number): Promise<void> {
        return new Promise<void>(resolve => this.scheduleDelayedCallback(resolve, delayMs));
    }

    /**
     * Convert the WebSocket-style serverUrl to an HTTP base URL.
     * wss:// -> https://, ws:// -> http://, strips trailing slash.
     */
    private getHttpBaseUrl(): string {
        let url = this.serverUrl;
        if (url.startsWith('wss://')) {
            url = 'https://' + url.substring(6);
        } else if (url.startsWith('ws://')) {
            url = 'http://' + url.substring(5);
        }
        return url.replace(/\/$/, '');
    }

    /** Schedule on the Lens scripting thread (also works in Node tests). */
    private scheduleDelayedCallback(callback: () => void, delayMs: number): CancelDelay | void {
        return this.scheduler(callback, delayMs);
    }

    /** Log a message if debug logging is enabled. */
    private log(message: string): void {
        if (this.debugLogging) {
            print('[EstuaryHttpClient] ' + message);
        }
    }
}
