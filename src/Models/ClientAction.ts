/**
 * Client action — a typed in-world action call from the AI character.
 *
 * Emitted by the server via native LLM function calling (SCRUM-202,
 * contract v1.9). Replaces the legacy inline XML <action name="..." />
 * tags that used to ride inside bot_response.text. See SDK_CONTRACT.md
 * §Features > client_action for the canonical contract.
 */
export interface ClientActionEvent {
    /**
     * The action name exactly as declared on the character
     * (NOT the sanitized function-calling name).
     */
    name: string;

    /**
     * Action parameters, validated server-side against the character's
     * declared AgentAction.parameters (types already coerced to the
     * declared string/number/boolean; undeclared arguments dropped).
     * Empty object for parameterless actions.
     */
    arguments: { [param: string]: string | number | boolean };

    /** Correlates the action with the same turn's bot_response / bot_voice stream */
    messageId: string;

    /** Sentence counter at the moment the action was emitted (see bot_response.chunk_index) */
    chunkIndex: number;

    /** ISO 8601 server emit time */
    timestamp: string;
}

/**
 * Raw payload from the server (defensively accepts both camelCase and snake_case
 * so the SDK survives any future server drift).
 */
interface ClientActionJson {
    name?: string;
    arguments?: { [param: string]: string | number | boolean };
    message_id?: string;
    messageId?: string;
    chunk_index?: number;
    chunkIndex?: number;
    timestamp?: string;
}

/**
 * Parse a ClientActionEvent from a raw server payload. Returns null if the
 * payload is missing the required action name.
 */
export function parseClientAction(json: ClientActionJson): ClientActionEvent | null {
    if (!json) return null;
    const name = json.name || '';
    if (!name) return null;
    const args = (json.arguments && typeof json.arguments === 'object')
        ? json.arguments
        : {};
    return {
        name,
        arguments: args,
        messageId: json.message_id || json.messageId || '',
        chunkIndex: json.chunk_index ?? json.chunkIndex ?? 0,
        timestamp: json.timestamp || '',
    };
}
