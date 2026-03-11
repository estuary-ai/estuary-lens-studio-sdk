/**
 * HTTP client for Estuary REST API endpoints on Lens Studio / Spectacles.
 *
 * Uses Lens Studio's RemoteServiceHttpRequest + InternetModule.performHttpRequest()
 * for all HTTP operations. This is the same proven pattern used by EstuaryClient
 * for Engine.IO polling.
 *
 * Because Spectacles cannot use multipart/form-data (Fetch API only supports string
 * bodies), image uploads use JSON+base64 encoding.
 */

import { EstuaryConfig } from './EstuaryConfig';
import { getInternetModule } from './EstuaryClient';
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
 * Uses the same InternetModule as EstuaryClient. Call setInternetModule()
 * before using this client.
 */
export class EstuaryHttpClient {
    private serverUrl: string;
    private apiKey: string;
    private playerId: string;
    private debugLogging: boolean;

    /** Active polling timer reference (DelayedCallbackEvent or setTimeout handle) */
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
     * @param onSuccess Called with the created AgentResponse on success
     * @param onError Called with an error message on failure
     */
    uploadImageToCharacter(
        imageBase64: string,
        mimeType: string,
        onSuccess: (agent: AgentResponse) => void,
        onError: (error: string) => void
    ): void {
        const url = this.getHttpBaseUrl() + '/api/generate/image-to-character';
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.apiKey) {
            headers['X-API-Key'] = this.apiKey;
        }
        if (this.playerId) {
            headers['X-Player-Id'] = this.playerId;
        }

        const body = JSON.stringify({
            image: imageBase64,
            mime_type: mimeType,
        });

        this.log(`Uploading image to character (${mimeType}, ${Math.round(imageBase64.length / 1024)}KB base64)`);

        this.performRequest('Post', url, headers, body, (statusCode: number, responseBody: string) => {
            if (statusCode >= 200 && statusCode < 300) {
                try {
                    const json = JSON.parse(responseBody);
                    const agent = parseAgentResponse(json);
                    this.log(`Character created: ${agent.id} "${agent.name}"`);
                    onSuccess(agent);
                } catch (e) {
                    onError('Failed to parse character response: ' + e);
                }
            } else {
                onError(`Upload failed with status ${statusCode}: ${responseBody.substring(0, 200)}`);
            }
        }, onError);
    }

    /**
     * Get the current model generation status for an agent.
     * GET /api/generate/{agentId}/model-status.
     *
     * @param agentId Agent UUID to check
     * @param onSuccess Called with the ModelStatusResponse
     * @param onError Called with an error message on failure
     */
    getModelStatus(
        agentId: string,
        onSuccess: (status: ModelStatusResponse) => void,
        onError: (error: string) => void
    ): void {
        const url = this.getHttpBaseUrl() + '/api/generate/' + agentId + '/model-status';
        const headers: Record<string, string> = {};

        if (this.apiKey) {
            headers['X-API-Key'] = this.apiKey;
        }

        this.performRequest('Get', url, headers, null, (statusCode: number, responseBody: string) => {
            if (statusCode >= 200 && statusCode < 300) {
                try {
                    const json = JSON.parse(responseBody);
                    const status = parseModelStatusResponse(json);
                    onSuccess(status);
                } catch (e) {
                    onError('Failed to parse model status response: ' + e);
                }
            } else {
                onError(`Model status request failed with status ${statusCode}: ${responseBody.substring(0, 200)}`);
            }
        }, onError);
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

        const doPoll = (): void => {
            if (!this._pollActive) {
                return;
            }

            this.getModelStatus(agentId, (status: ModelStatusResponse) => {
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
                this.scheduleDelayedCallback(doPoll, intervalMs);

            }, (error: string) => {
                if (!this._pollActive) {
                    return;
                }
                this._pollActive = false;
                onError(error);
            });
        };

        // Start first poll after initial interval
        this.scheduleDelayedCallback(doPoll, intervalMs);
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
     * @param onSuccess Called with the paginated CharacterListResponse
     * @param onError Called with an error message on failure
     * @param limit Maximum number of results (default: 20)
     * @param offset Offset into the result set (default: 0)
     */
    getCharacters(
        onSuccess: (response: CharacterListResponse) => void,
        onError: (error: string) => void,
        limit: number = 20,
        offset: number = 0
    ): void {
        const url = this.getHttpBaseUrl() + '/api/v1/characters?limit=' + limit + '&offset=' + offset;
        const headers: Record<string, string> = {};

        if (this.apiKey) {
            headers['X-API-Key'] = this.apiKey;
        }
        if (this.playerId) {
            headers['X-Player-Id'] = this.playerId;
        }

        this.performRequest('Get', url, headers, null, (statusCode: number, responseBody: string) => {
            if (statusCode >= 200 && statusCode < 300) {
                try {
                    const json = JSON.parse(responseBody);
                    const response = parseCharacterListResponse(json);
                    this.log(`Characters listed: ${response.characters.length} of ${response.total}`);
                    onSuccess(response);
                } catch (e) {
                    onError('Failed to parse character list response: ' + e);
                }
            } else {
                onError(`Character list request failed with status ${statusCode}: ${responseBody.substring(0, 200)}`);
            }
        }, onError);
    }

    // ---- Private helpers ----

    /**
     * Perform an HTTP request using Lens Studio's RemoteServiceHttpRequest API.
     *
     * @param method HTTP method ('Get' or 'Post')
     * @param url Full request URL
     * @param headers Request headers to set
     * @param body Request body (for POST) or null (for GET)
     * @param onResponse Called with (statusCode, responseBody)
     * @param onError Called with error message
     */
    private performRequest(
        method: string,
        url: string,
        headers: Record<string, string>,
        body: string | null,
        onResponse: (statusCode: number, body: string) => void,
        onError: (error: string) => void
    ): void {
        const internetModule = getInternetModule();

        // @ts-ignore - Lens Studio global API
        if (typeof RemoteServiceHttpRequest === 'undefined') {
            onError('RemoteServiceHttpRequest is not available on this platform');
            return;
        }

        if (!internetModule || typeof internetModule.performHttpRequest !== 'function') {
            onError('InternetModule is not set. Call setInternetModule() before using EstuaryHttpClient.');
            return;
        }

        // @ts-ignore - Lens Studio global API
        const request = RemoteServiceHttpRequest.create();
        request.url = url;

        // Set HTTP method
        if (method === 'Post') {
            // @ts-ignore - Lens Studio enum
            request.method = RemoteServiceHttpRequest.HttpRequestMethod.Post;
        } else {
            // @ts-ignore - Lens Studio enum
            request.method = RemoteServiceHttpRequest.HttpRequestMethod.Get;
        }

        // Set body for POST requests
        if (body !== null) {
            request.body = body;
        }

        // Set Content-Type if present in headers
        if (headers['Content-Type']) {
            request.contentType = headers['Content-Type'];
        }

        // Lens Studio's RemoteServiceHttpRequest does not support setting arbitrary
        // custom headers directly. Auth headers (X-API-Key, X-Player-Id) are passed
        // as query parameters instead.
        let authUrl = url;
        const queryParams: string[] = [];

        if (headers['X-API-Key']) {
            queryParams.push('api_key=' + encodeURIComponent(headers['X-API-Key']));
        }
        if (headers['X-Player-Id']) {
            queryParams.push('player_id=' + encodeURIComponent(headers['X-Player-Id']));
        }

        if (queryParams.length > 0) {
            const separator = authUrl.indexOf('?') >= 0 ? '&' : '?';
            authUrl = authUrl + separator + queryParams.join('&');
            request.url = authUrl;
        }

        this.log(`HTTP ${method} ${request.url.substring(0, 100)}`);

        internetModule.performHttpRequest(request, (response: any) => {
            try {
                const statusCode = response.statusCode || response.code || 0;
                const responseBody = response.body || '';

                this.log(`HTTP response: status=${statusCode}, body=${responseBody.substring(0, 200)}`);

                if (statusCode === 0) {
                    onError('Network error: no response received');
                    return;
                }

                onResponse(statusCode, responseBody);
            } catch (e) {
                onError('Error processing HTTP response: ' + e);
            }
        });
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
