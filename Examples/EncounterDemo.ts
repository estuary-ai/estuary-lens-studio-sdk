/**
 * EncounterDemo.ts
 *
 * EXAMPLE: Drive a stateless 2-character "Encounter" against the Estuary
 * backend. Calls `EstuaryManager.instance.startEncounter(...)`, subscribes
 * to the room, and renders the streamed alternating-turn messages to a Text
 * component. With `voice` enabled it dispatches `encounter_voice` PCM frames
 * to two `DynamicAudioOutput` instances (one per speaker, from
 * `RemoteServiceGateway.lspkg`).
 *
 * Setup in Lens Studio:
 *  1. Add this script to a SceneObject in your scene.
 *  2. Wire `characterAId` and `characterBId` to two character UUIDs owned
 *     by the API key configured on `EstuaryCredentials` /
 *     `SimpleAutoConnect`.
 *  3. (Optional) Wire `textComponent` to a `Component.Text` in your UI.
 *  4. (Optional, only when `voice = true`) wire two SceneObjects holding
 *     `DynamicAudioOutput` scripts to `audioOutputA` / `audioOutputB`.
 *  5. The Estuary stack must already be authenticated by another bootstrap
 *     script (typically `SimpleAutoConnect`) before this Behavior fires.
 *
 * The base64 → PCM playback path is lifted from
 * `Examples/EstuaryVoiceConnection.ts:404-415` (per-frame `Base64.decode(...)`
 * -> `addAudioFrame(pcmBytes, 1)`).
 */

import { EstuaryManager } from "../src/Components/EstuaryManager";
import { ConnectionState } from "../src/Core/EstuaryEvents";
import { EncounterMessage } from "../src/Models/EncounterMessage";
import { EncounterVoice } from "../src/Models/EncounterVoice";
import { EncounterEnd } from "../src/Models/EncounterEnd";

/**
 * Local duck-typed interface for `DynamicAudioOutput` from
 * `RemoteServiceGateway.lspkg`. Lifted from
 * `Examples/EstuaryVoiceConnection.ts:48-50` so we don't depend on the
 * package's type surface (it's not exported).
 */
interface DynamicAudioOutput {
    initialize?(sampleRate: number): void;
    addAudioFrame(uint8Array: Uint8Array, channels: number): void;
    interruptAudioOutput?(): void;
}

@component
export class EncounterDemo extends BaseScriptComponent {

    @input
    @hint("Owned character A UUID — must satisfy Agent.user_id == api_key_user_id")
    characterAId: string = "";

    @input
    @hint("Owned character B UUID — must satisfy Agent.user_id == api_key_user_id")
    characterBId: string = "";

    @input
    @hint("Topic / scene prompt fed to both characters (1..2000 chars).")
    @widget(new TextAreaWidget())
    prompt: string = "Argue about whether pineapple belongs on pizza.";

    @input
    @hint("Max turns (one message per turn). Server hard-caps at 20.")
    maxTurns: number = 6;

    @input
    @hint("If true, server synthesizes TTS via ElevenLabs and emits encounter_voice events.")
    voice: boolean = false;

    @input
    @hint("Optional Text component to render messages as they arrive")
    @allowUndefined
    textComponent: Text;

    @input
    @hint("DynamicAudioOutput SceneObject for speaker A (RemoteServiceGateway.lspkg) — required if voice=true")
    @allowUndefined
    audioOutputAObject: SceneObject;

    @input
    @hint("DynamicAudioOutput SceneObject for speaker B (RemoteServiceGateway.lspkg) — required if voice=true")
    @allowUndefined
    audioOutputBObject: SceneObject;

    @input
    @hint("Auto-start on awake (otherwise call EncounterDemo.start() from another script)")
    autoStart: boolean = true;

    @input
    @hint("Enable debug logging")
    debugLogging: boolean = false;

    // ==================== State ====================
    private _started: boolean = false;
    private _ended: boolean = false;
    private _buffer: string = "";
    private _audioOutputA: DynamicAudioOutput | null = null;
    private _audioOutputB: DynamicAudioOutput | null = null;

    // ==================== Lifecycle ====================
    onAwake(): void {
        if (!this.autoStart) {
            return;
        }
        const updateEvent = this.createEvent("UpdateEvent");
        updateEvent.bind(() => this.onUpdate());
    }

    /** Public entry point — call manually if `autoStart=false`. */
    public start(): void {
        if (this._started) return;
        this.tryStartIfReady();
    }

    private onUpdate(): void {
        if (this._started) return;
        if (!EstuaryManager.hasInstance) return;
        if (EstuaryManager.instance.connectionState !== ConnectionState.Connected) return;
        this.tryStartIfReady();
    }

    private tryStartIfReady(): void {
        if (this._started) return;
        if (!EstuaryManager.hasInstance) {
            this.logError("EstuaryManager singleton not initialized — bootstrap a SimpleAutoConnect first");
            return;
        }
        if (!this.characterAId || !this.characterBId) {
            this.logError("characterAId and characterBId must both be set in the Inspector");
            return;
        }
        this._started = true;

        if (this.voice) {
            this._audioOutputA = this.resolveAudioOutput(this.audioOutputAObject, "A");
            this._audioOutputB = this.resolveAudioOutput(this.audioOutputBObject, "B");
        }

        // Register listeners BEFORE issuing startEncounter — the server begins
        // streaming as soon as the background task spins up, and we don't want
        // to miss the first emit if it races our subscribe.
        const mgr = EstuaryManager.instance;
        mgr.onEncounterMessage((m: EncounterMessage) => this.onMessage(m));
        mgr.onEncounterVoice((v: EncounterVoice) => this.onVoice(v));
        mgr.onEncounterEnd((e: EncounterEnd) => this.onEnd(e));

        this.kickoff();
    }

    private async kickoff(): Promise<void> {
        const mgr = EstuaryManager.instance;
        try {
            const { encounterId } = await mgr.startEncounter({
                characterAId: this.characterAId,
                characterBId: this.characterBId,
                prompt: this.prompt,
                maxTurns: this.maxTurns,
                voice: this.voice,
                starter: "a",
            });
            print(`[EncounterDemo] encounterId=${encounterId}`);
            mgr.subscribeEncounter(encounterId);
        } catch (e) {
            this.logError(`startEncounter failed: ${e}`);
        }
    }

    // ==================== Event Handlers ====================
    private onMessage(m: EncounterMessage): void {
        const line = `[${m.speaker.toUpperCase()}] ${m.text}`;
        this._buffer += this._buffer ? ("\n" + line) : line;
        if (this.textComponent) {
            this.textComponent.text = this._buffer;
        }
        print(`[EncounterDemo] (${m.turnIndex}) ${line}`);
    }

    private onVoice(v: EncounterVoice): void {
        if (!this.voice) return;

        // Ignore the per-turn terminator (audio === "" with isFinal: true).
        if (!v.audio || v.audio.length === 0) {
            this.log(`Voice terminator for speaker=${v.speaker} turn=${v.turnIndex}`);
            return;
        }

        const target = v.speaker === "a" ? this._audioOutputA : this._audioOutputB;
        if (!target) {
            this.log(`No DynamicAudioOutput wired for speaker ${v.speaker} — dropping ${v.audio.length} chars of audio`);
            return;
        }

        try {
            // Lens Studio exposes `Base64` as a global — decode returns a
            // Uint8Array of PCM 16-bit little-endian samples (24 kHz mono per
            // the server's output_format).
            // @ts-ignore - Lens Studio global Base64
            const pcmBytes = Base64.decode(v.audio);
            target.addAudioFrame(pcmBytes, 1);
        } catch (e) {
            this.logError(`Failed to dispatch encounter_voice frame for speaker=${v.speaker}: ${e}`);
        }
    }

    private onEnd(e: EncounterEnd): void {
        if (this._ended) return;
        this._ended = true;
        print(`[EncounterDemo] Encounter ended: reason=${e.reason} turns=${e.turnsEmitted}`);
    }

    // ==================== Helpers ====================
    private resolveAudioOutput(obj: SceneObject, label: string): DynamicAudioOutput | null {
        if (!obj) {
            this.log(`No SceneObject wired for speaker ${label}`);
            return null;
        }
        const scripts = obj.getComponents("Component.ScriptComponent") as any[];
        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (!sc) continue;
            // Duck-type detect: DynamicAudioOutput exposes addAudioFrame(uint8Array, channels).
            if (typeof sc.addAudioFrame === "function") {
                this.log(`Found DynamicAudioOutput for speaker ${label}`);
                return sc as DynamicAudioOutput;
            }
        }
        this.logError(`SceneObject for speaker ${label} has no DynamicAudioOutput script`);
        return null;
    }

    private log(message: string): void {
        if (this.debugLogging) {
            print(`[EncounterDemo] ${message}`);
        }
    }

    private logError(message: string): void {
        print(`[EncounterDemo] ERROR: ${message}`);
    }
}
