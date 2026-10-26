import { EstuaryCharacter } from './EstuaryCharacter';
import { ClientActionEvent } from '../Models/ClientAction';

/** Structural subset of Lens AnimationPlayer, also suitable for an app adapter. */
export interface ClipPlayer {
    clips: ReadonlyArray<{ name: string }>;
    playClipAt(name: string, time: number): void;
    stopClip(name: string): void;
}

/** Plays an exact or unique suffix match: fold_arms -> preset:biped:fold_arms. */
export class EstuaryClipPlayer {
    private activeClip = '';
    private readonly onAction = (action: ClientActionEvent) => this.playAction(action.name);
    private readonly onDisposed = () => this.dispose();

    constructor(private character: EstuaryCharacter, private player: ClipPlayer) {
        character.on('clientAction', this.onAction);
        character.on('disposed', this.onDisposed);
    }

    playAction(action: string): boolean {
        const names = this.player.clips.map(clip => clip.name);
        const matches = names.filter(name => name.split(':').pop() === action);
        const name = names.includes(action) ? action : matches.length === 1 ? matches[0] : undefined;
        if (!name) return false; // Never guess between ambiguous rig prefixes.
        if (this.activeClip) this.player.stopClip(this.activeClip);
        this.player.playClipAt(name, 0);
        this.activeClip = name;
        return true;
    }

    dispose(): void {
        this.character.off('clientAction', this.onAction);
        this.character.off('disposed', this.onDisposed);
        if (this.activeClip) this.player.stopClip(this.activeClip);
        this.activeClip = '';
    }
}
