/**
 * Paginated character list response from GET /api/v1/characters.
 */

import { AgentResponse, parseAgentResponse } from './AgentResponse';

export interface CharacterListResponse {
    /** Array of character/agent objects */
    characters: AgentResponse[];
    /** Total number of characters matching the query */
    total: number;
    /** Maximum number of results per page */
    limit: number;
    /** Offset into the result set */
    offset: number;
}

/**
 * Raw character list JSON from the server.
 */
interface CharacterListResponseJson {
    characters?: any[];
    total?: number;
    limit?: number;
    offset?: number;
}

/**
 * Parse a CharacterListResponse from a raw JSON object.
 * The characters array items may use either snake_case (CharacterResponse)
 * or camelCase (Agent.to_dict()) keys; parseAgentResponse handles both.
 */
export function parseCharacterListResponse(json: CharacterListResponseJson): CharacterListResponse {
    const characters = (json.characters || []).map((c: any) => parseAgentResponse(c));
    return {
        characters,
        total: json.total ?? characters.length,
        limit: json.limit ?? 20,
        offset: json.offset ?? 0,
    };
}
