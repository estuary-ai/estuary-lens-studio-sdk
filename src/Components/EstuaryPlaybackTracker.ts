import { EstuaryCharacter } from './EstuaryCharacter';
import { BotVoice } from '../Models/BotVoice';
import { InterruptData } from '../Models/InterruptData';

export interface PlaybackOutput {
    addAudioFrame(bytes: Uint8Array, channels: number): void;
    interruptAudioOutput(): void;
}

interface PendingPlayback { end: number; final: boolean; hasAudio: boolean; }

/**
 * Bridges streamed PCM and a verified native playout clock to completion reports.
 * Without a clock it preserves normal RSG playback and the server's duration estimate.
 * AudioComponent.position is a candidate clock; enable it only after verifying it
 * advances with playout for the target dynamic AudioTrack/runtime (including underruns).
 */
export class EstuaryPlaybackTracker {
    private pending = new Map<string, PendingPlayback>();
    private blocked = new Set<string>();
    private queuedMessages = new Set<string>();
    private lastPosition = 0;
    private scheduledEnd = 0;
    private latestMessage = '';
    private clockValid = true;
    private subscriptions: Array<[string, Function]> = [];

    constructor(
        private character: EstuaryCharacter,
        private output: PlaybackOutput,
        private readPosition?: () => number,
        private decode: (base64: string) => Uint8Array = value => Base64.decode(value),
    ) {
        this.listen('voiceReceived', (voice: BotVoice) => this.add(voice));
        this.listen('interrupt', (data: InterruptData) => this.interrupt(data.messageId));
        this.listen('disconnected', () => this.reset());
        this.listen('sessionTimeout', () => this.reset());
        this.listen('sessionRejected', () => this.reset());
        this.listen('moderationWarning', (data: { level: string }) => { if (data.level === 'terminated') this.reset(); });
        this.listen('connected', () => { this.reset(); this.clockValid = true; });
        this.listen('disposed', () => this.dispose());
    }

    private listen(event: string, handler: Function): void {
        this.character.on(event, handler);
        this.subscriptions.push([event, handler]);
    }

    private position(): number | null {
        if (!this.readPosition || !this.clockValid) return null;
        let position: number;
        try { position = this.readPosition(); } catch (_) { position = NaN; }
        if (!Number.isFinite(position) || position < this.lastPosition) {
            // A reset/unsupported clock must never create a false completion.
            this.clockValid = false;
            this.pending.clear();
            return null;
        }
        this.lastPosition = position;
        return position;
    }

    private add(voice: BotVoice): void {
        if (this.blocked.has(voice.messageId)) return;
        const bytes = voice.audio ? this.decode(voice.audio) : new Uint8Array(0);
        if (bytes.length % 2 !== 0) return; // Mono PCM16 must contain whole samples.
        if (bytes.length) {
            this.output.addAudioFrame(bytes, 1);
            this.latestMessage = voice.messageId;
            this.queuedMessages.add(voice.messageId);
        }
        // Sample the cursor after enqueue: any synchronous native back-pressure
        // makes this conservative rather than claiming completion too early.
        const position = this.position();
        if (position === null || !voice.messageId) return;
        let pending = this.pending.get(voice.messageId);
        if (!pending) {
            pending = { end: position, final: false, hasAudio: false };
            this.pending.set(voice.messageId, pending);
        }
        if (bytes.length && voice.sampleRate > 0) {
            this.scheduledEnd = Math.max(this.scheduledEnd, position) + bytes.length / (2 * voice.sampleRate);
            pending.end = this.scheduledEnd;
            pending.hasAudio = true;
        }
        pending.final = pending.final || voice.isFinal === true;
    }

    /** Call from the host's UpdateEvent. A temporary empty queue is not a final stream. */
    tick(): void {
        const position = this.position();
        if (position === null) return;
        this.pending.forEach((pending, id) => {
            if (pending.final && pending.hasAudio && position >= pending.end) {
                this.pending.delete(id);
                this.queuedMessages.delete(id);
                this.blocked.add(id);
                this.character.notifyAudioPlaybackComplete(id);
            }
        });
    }

    private interrupt(messageId?: string): void {
        const id = messageId || this.latestMessage;
        if (id) { this.blocked.add(id); this.pending.delete(id); }
        // Native output cannot selectively remove an older queued message. Flush
        // the shared buffer if it may still contain that message (including redactions).
        // After a verified drain or prior flush, a late interrupt leaves new audio alone.
        if (!id || this.queuedMessages.has(id)) this.reset(false);
    }

    private reset(clearBlocked = true): void {
        this.output.interruptAudioOutput();
        this.pending.clear();
        this.queuedMessages.clear();
        this.scheduledEnd = 0;
        this.lastPosition = 0;
        this.latestMessage = '';
        if (clearBlocked) this.blocked.clear();
    }

    dispose(): void {
        this.reset();
        for (const [event, handler] of this.subscriptions) this.character.off(event, handler);
        this.subscriptions = [];
    }
}
