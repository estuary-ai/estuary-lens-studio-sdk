/**
 * HTTP client for Estuary REST API endpoints on Lens Studio / Spectacles.
 *
 * Uses the global Fetch API (available in Lens Studio 5.3+ / Spectacles OS 5.58+)
 * for all HTTP operations. Auth credentials are sent via X-API-Key and X-Player-Id
 * headers rather than query parameters.
 *
 * Because Spectacles cannot use multipart/form-data (Fetch API only supports string
 * bodies), image uploads use JSON+base64 encoding.
 */

import { EstuaryConfig } from './EstuaryConfig';
import { AgentResponse, parseAgentResponse } from '../Models/AgentResponse';
import {
    ModelStatusResponse,
    parseModelStatusResponse,
    isModelCompleted,
    isModelFailed,
    isModelTextureFailed,
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
 * Uses the global fetch() API. Requires Lens Studio 5.3+ / Spectacles OS 5.58+.
 */
export class EstuaryHttpClient {
    private serverUrl: string;
    private apiKey: string;
    private playerId: string;
    private debugLogging: boolean;

    /** Whether polling is currently active */
    private _pollActive: boolean = false;

    constructor(config: EstuaryConfig) {
        this.serverUrl = (config.serverUrl || '').replace(/\/$/, '');
        this.apiKey = config.apiKey || '';
        this.playerId = config.playerId || '';
        this.debugLogging = config.debugLogging || false;
    }

    // ---- Public API ----

    /**
     * Upload a base64-encoded image to create a new character.
     * POST /api/generate/image-to-character with Content-Type: application/json.
     *
     * @param imageBase64 Base64-encoded image data (no data URI prefix)
     * @param mimeType MIME type of the image (e.g., "image/jpeg", "image/png")
     * @returns The created AgentResponse
     */
    async uploadImageToCharacter(imageBase64: string, mimeType: string): Promise<AgentResponse> {
        const url = this.getHttpBaseUrl() + '/api/generate/image-to-character';
        const body = JSON.stringify({
            image: imageBase64,
            mime_type: mimeType,
        });

        this.log(`Uploading image to character (${mimeType}, ${Math.round(imageBase64.length / 1024)}KB base64)`);

        const { status, body: responseBody } = await this.fetchJson('POST', url, body);

        if (status >= 200 && status < 300) {
            const json = JSON.parse(responseBody);
            const agent = parseAgentResponse(json);
            this.log(`Character created: ${agent.id} "${agent.name}"`);
            return agent;
        } else {
            throw new Error(`Upload failed with status ${status}: ${responseBody.substring(0, 200)}`);
        }
    }

    /**
     * Get the current model generation status for an agent.
     * GET /api/generate/{agentId}/model-status.
     *
     * @param agentId Agent UUID to check
     * @returns The ModelStatusResponse
     */
    async getModelStatus(agentId: string): Promise<ModelStatusResponse> {
        const url = this.getHttpBaseUrl() + '/api/generate/' + agentId + '/model-status';

        const { status, body: responseBody } = await this.fetchJson('GET', url);

        if (status >= 200 && status < 300) {
            const json = JSON.parse(responseBody);
            return parseModelStatusResponse(json);
        } else {
            throw new Error(`Model status request failed with status ${status}: ${responseBody.substring(0, 200)}`);
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
     */
    pollModelStatus(
        agentId: string,
        onStatusChanged: (status: ModelStatusResponse) => void,
        onCompleted: (status: ModelStatusResponse) => void,
        onError: (error: string) => void,
        initialIntervalMs: number = 2000,
        maxIntervalMs: number = 10000
    ): void {
        this.stopPolling();
        this._pollActive = true;

        let intervalMs = initialIntervalMs;
        let lastStatus = '';
        let lastProgress = -1;

        const doPoll = async (): Promise<void> => {
            if (!this._pollActive) {
                return;
            }

            try {
                const status = await this.getModelStatus(agentId);

                if (!this._pollActive) {
                    return;
                }

                // Notify on status or progress change
                if (status.modelStatus !== lastStatus || status.progress !== lastProgress) {
                    lastStatus = status.modelStatus;
                    lastProgress = status.progress;
                    onStatusChanged(status);
                }

                // Terminal states
                if (isModelCompleted(status) || isModelTextureFailed(status)) {
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
                if (!this._pollActive) {
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

    // ---- Private helpers ----

    /**
     * Perform an HTTP request using the global Fetch API.
     *
     * @param method HTTP method ('GET' or 'POST')
     * @param url Full request URL
     * @param body Request body (for POST) or undefined (for GET)
     * @returns Object with status code and response body text
     */
    private async fetchJson(method: 'GET' | 'POST', url: string, body?: string): Promise<{ status: number; body: string }> {
        const headers: Record<string, string> = {};

        if (method === 'POST') {
            headers['Content-Type'] = 'application/json';
        }

        if (this.apiKey) {
            headers['X-API-Key'] = this.apiKey;
        }
        if (this.playerId) {
            headers['X-Player-Id'] = this.playerId;
        }

        this.log(`HTTP ${method} ${url.substring(0, 100)}`);

        const response = await fetch(url, { method, headers, body });
        const text = await response.text();

        this.log(`HTTP response: status=${response.status}, body=${text.substring(0, 200)}`);

        return { status: response.status, body: text };
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

    /**
     * Schedule a delayed callback. Uses a simple setTimeout pattern
     * which works in both Lens Studio runtime and standard JS environments.
     */
    private scheduleDelayedCallback(callback: () => void, delayMs: number): void {
        // @ts-ignore - Lens Studio global or standard JS
        if (typeof DelayedCallbackEvent !== 'undefined') {
            // @ts-ignore - Lens Studio delayed callback API
            const event = DelayedCallbackEvent.create();
            event.bind(callback);
            event.reset(delayMs / 1000); // Lens Studio uses seconds
        } else if (typeof setTimeout !== 'undefined') {
            setTimeout(callback, delayMs);
        } else {
            // Fallback: call immediately (not ideal but prevents hanging)
            callback();
        }
    }

    /** Log a message if debug logging is enabled. */
    private log(message: string): void {
        if (this.debugLogging) {
            print('[EstuaryHttpClient] ' + message);
        }
    }
}
