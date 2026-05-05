/**
 * Encounter voice chunk — base64 PCM audio (24 kHz mono) for one TTS frame
 * within a turn. Emitted only when the encounter was started with
 * ``voice: true``. The server emits one event per ElevenLabs PCM byte chunk
 * with ``isFinal: false``, followed by an empty-audio terminator
 * (``audio: ""``, ``isFinal: true``) per turn so consumers can flush
 * playback boundaries.
 *
 * See SDK_CONTRACT.md §Features > encounter for the canonical contract.
 */
export interface EncounterVoice {
    /** Encounter UUID returned by POST /api/encounters */
    encounterId: string;

    /** Which character is speaking this chunk */
    speaker: "a" | "b";

    /** Zero-based turn index this chunk belongs to */
    turnIndex: number;

    /** Base64-encoded PCM 24 kHz mono. Empty string on the per-turn terminator. */
    audio: string;

    /** True only on the per-turn terminator frame (audio === ""). */
    isFinal: boolean;
}

/**
 * Raw payload from the server (defensively accepts both camelCase and snake_case).
 */
interface EncounterVoiceJson {
    encounterId?: string;
    encounter_id?: string;
    speaker?: string;
    turnIndex?: number;
    turn_index?: number;
    audio?: string;
    isFinal?: boolean;
    is_final?: boolean;
}

/**
 * Parse an EncounterVoice from a raw server payload. Returns null on missing
 * encounterId or invalid speaker tag.
 */
export function parseEncounterVoice(json: EncounterVoiceJson): EncounterVoice | null {
    if (!json) return null;
    const encounterId = json.encounterId || json.encounter_id || '';
    const speaker = json.speaker;
    const turnIndex = json.turnIndex ?? json.turn_index ?? 0;
    const audio = json.audio ?? '';
    const isFinal = json.isFinal ?? json.is_final ?? false;
    if (!encounterId) return null;
    if (speaker !== 'a' && speaker !== 'b') return null;
    return {
        encounterId,
        speaker,
        turnIndex,
        audio,
        isFinal,
    };
}
