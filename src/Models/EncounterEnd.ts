/**
 * Encounter terminator — fired exactly once per encounter when the loop
 * exits. See SDK_CONTRACT.md §Features > encounter for the canonical
 * contract.
 */
export interface EncounterEnd {
    /** Encounter UUID returned by POST /api/encounters */
    encounterId: string;

    /**
     * Termination reason:
     * - ``"max_turns_reached"`` — normal completion (the only success terminus at MVP).
     * - ``"cancelled"`` — task was cancelled (not triggered on client disconnect at MVP).
     * - ``"error"`` — the conversation loop raised an unhandled exception.
     */
    reason: string;

    /** Total number of turns the loop emitted before terminating. */
    turnsEmitted: number;
}

/**
 * Raw payload from the server (defensively accepts both camelCase and snake_case).
 */
interface EncounterEndJson {
    encounterId?: string;
    encounter_id?: string;
    reason?: string;
    turnsEmitted?: number;
    turns_emitted?: number;
}

/**
 * Parse an EncounterEnd from a raw server payload. Returns null on missing
 * encounterId.
 */
export function parseEncounterEnd(json: EncounterEndJson): EncounterEnd | null {
    if (!json) return null;
    const encounterId = json.encounterId || json.encounter_id || '';
    if (!encounterId) return null;
    return {
        encounterId,
        reason: json.reason || 'unknown',
        turnsEmitted: json.turnsEmitted ?? json.turns_emitted ?? 0,
    };
}
