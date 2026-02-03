/**
 * Configuration interface for Estuary SDK.
 */

/**
 * Estuary SDK configuration options.
 */
export interface EstuaryConfig {
    /** Estuary server URL (e.g., "wss://your-server.com" or "ws://localhost:4001") */
    serverUrl: string;

    /** Your Estuary API key (optional - depends on your backend) */
    apiKey?: string;

    /** The UUID of the character to connect to */
    characterId: string;

    /** Unique identifier for the player (used for conversation persistence) */
    playerId: string;

    /** Sample rate for microphone recording (must be 16000 for STT) */
    recordingSampleRate?: number;

    /** Expected sample rate for voice playback (16000 for Spectacles, 48000 for desktop) */
    playbackSampleRate?: number;

    /** Duration of audio chunks to send (in milliseconds) */
    audioChunkDurationMs?: number;

    /** Automatically reconnect if connection is lost */
    autoReconnect?: boolean;

    /** Maximum number of reconnection attempts */
    maxReconnectAttempts?: number;

    /** Delay between reconnection attempts (in milliseconds) */
    reconnectDelayMs?: number;

    /** Enable debug logging */
    debugLogging?: boolean;
}

/**
 * Default configuration values.
 * Note: playbackSampleRate is 16000 for Spectacles hardware optimization.
 */
export const DEFAULT_CONFIG: Required<Omit<EstuaryConfig, 'serverUrl' | 'apiKey' | 'characterId' | 'playerId'>> = {
    recordingSampleRate: 16000,
    playbackSampleRate: 16000,  // 16kHz for Spectacles (hardware optimized)
    audioChunkDurationMs: 100,
    autoReconnect: true,
    maxReconnectAttempts: 5,
    reconnectDelayMs: 2000,
    debugLogging: false
};

/**
 * Merge user config with defaults.
 * @param config User configuration
 * @returns Complete configuration with defaults applied
 */
export function mergeWithDefaults(config: EstuaryConfig): Required<EstuaryConfig> {
    return {
        ...DEFAULT_CONFIG,
        ...config,
        serverUrl: config.serverUrl?.replace(/\/$/, '') || '', // Remove trailing slash
        apiKey: config.apiKey || '',
        characterId: config.characterId || '',
        playerId: config.playerId || ''
    };
}

/**
 * Validate configuration.
 * @param config Configuration to validate
 * @returns Error message if invalid, null if valid
 */
export function validateConfig(config: EstuaryConfig): string | null {
    if (!config.serverUrl) {
        return 'Server URL is not set';
    }

    // Accept http://, https://, ws://, or wss:// URLs
    const validPrefixes = ['http://', 'https://', 'ws://', 'wss://'];
    if (!validPrefixes.some(prefix => config.serverUrl.startsWith(prefix))) {
        return 'Server URL should start with http://, https://, ws://, or wss://';
    }

    // API key is optional - some backends don't require it
    // if (!config.apiKey) {
    //     return 'API key is not set';
    // }

    if (!config.characterId) {
        return 'Character ID is not set';
    }

    if (!config.playerId) {
        return 'Player ID is not set';
    }

    return null;
}

/**
 * Check if configuration is valid for connecting.
 * @param config Configuration to check
 * @returns True if configuration is valid
 */
export function isConfigValid(config: EstuaryConfig): boolean {
    return validateConfig(config) === null;
}

/**
 * Create a default configuration for development/testing.
 * @param apiKey API key to use
 * @param characterId Character ID to connect to
 * @param playerId Player ID for the session
 * @param serverUrl Server URL (default: localhost)
 * @returns Development configuration
 */
export function createDevConfig(
    apiKey: string,
    characterId: string,
    playerId: string,
    serverUrl: string = 'http://localhost:4001'
): EstuaryConfig {
    return {
        serverUrl,
        apiKey,
        characterId,
        playerId,
        debugLogging: true
    };
}





