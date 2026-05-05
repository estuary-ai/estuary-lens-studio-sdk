/**
 * Encounter message — one full turn of the 2-character A2A conversation.
 *
 * Emitted by the server once per turn (not per chunk). See SDK_CONTRACT.md
 * §Features > encounter for the canonical contract.
 */
export interface EncounterMessage {
    /** Encounter UUID returned by POST /api/encounters */
    encounterId: string;

    /** Which character spoke this turn */
    speaker: "a" | "b";

    /** Zero-based turn index */
    turnIndex: number;

    /** Full message text for this turn (post-clean: emojis and *action* tags stripped) */
    text: string;
}

/**
 * Raw payload from the server (defensively accepts both camelCase and snake_case
 * so the SDK survives any future server drift).
 */
interface EncounterMessageJson {
    encounterId?: string;
    encounter_id?: string;
    speaker?: string;
    turnIndex?: number;
    turn_index?: number;
    text?: string;
}

/**
 * Parse an EncounterMessage from a raw server payload. Returns null if the
 * payload is missing required fields or the speaker tag is invalid.
 */
export function parseEncounterMessage(json: EncounterMessageJson): EncounterMessage | null {
    if (!json) return null;
    const encounterId = json.encounterId || json.encounter_id || '';
    const speaker = json.speaker;
    const turnIndex = json.turnIndex ?? json.turn_index ?? 0;
    const text = json.text ?? '';
    if (!encounterId) return null;
    if (speaker !== 'a' && speaker !== 'b') return null;
    return {
        encounterId,
        speaker,
        turnIndex,
        text,
    };
}
