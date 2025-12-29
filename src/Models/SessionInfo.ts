/**
 * Session information received when connecting to an Estuary character.
 */
export interface SessionInfo {
    /** Unique identifier for this session */
    sessionId: string;
    
    /** Unique identifier for the conversation (persists across sessions) */
    conversationId: string;
    
    /** The character ID this session is connected to */
    characterId: string;
    
    /** The player ID associated with this session */
    playerId: string;
}

/**
 * Raw session info from server (snake_case)
 */
interface SessionInfoJson {
    session_id?: string;
    sessionId?: string;
    conversation_id?: string;
    conversationId?: string;
    character_id?: string;
    characterId?: string;
    player_id?: string;
    playerId?: string;
}

/**
 * Parse SessionInfo from JSON object
 */
export function parseSessionInfo(json: SessionInfoJson): SessionInfo {
    return {
        sessionId: json.session_id || json.sessionId || '',
        conversationId: json.conversation_id || json.conversationId || '',
        characterId: json.character_id || json.characterId || '',
        playerId: json.player_id || json.playerId || ''
    };
}

/**
 * Format SessionInfo as string for logging
 */
export function sessionInfoToString(info: SessionInfo): string {
    return `SessionInfo(SessionId=${info.sessionId}, ConversationId=${info.conversationId}, CharacterId=${info.characterId}, PlayerId=${info.playerId})`;
}





