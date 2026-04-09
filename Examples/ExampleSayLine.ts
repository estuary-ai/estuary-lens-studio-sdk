/**
 * ExampleSayLine.ts
 *
 * EXAMPLE: How to use sayLine() to script a character to say prewritten lines.
 *
 * sayLine() sends text directly to TTS — the character speaks the exact words
 * you provide, without going through the LLM. The line is saved to chat history
 * so the AI remembers it said this in future conversation turns.
 *
 * Use cases:
 * - NPC greetings when a player enters an area
 * - Scripted dialogue sequences in a game
 * - Tutorial narration from the character
 * - Story-driven cutscene lines
 *
 * Setup in Lens Studio:
 * 1. Make sure either EstuaryVoiceConnection OR EstuaryTextConnection is set up
 *    in your scene and working (this script needs an active Estuary connection)
 * 2. Create a SceneObject (e.g., "SayLine Test")
 * 3. Add this script to the SceneObject
 * 4. Tick "Auto Speak On Connect" to test immediately
 * 5. Run the scene — the character will speak the first line after connecting
 *
 * No inputs needed — this script uses EstuaryManager singleton directly.
 *
 * To trigger additional lines at runtime, call:
 *   exampleSayLine.sayNext()         — speak the next scripted line (with TTS)
 *   exampleSayLine.sayTextOnly()     — send a text-only line (no audio)
 *   exampleSayLine.say("custom text") — speak any arbitrary text
 */

import { EstuaryManager } from '../src/Components/EstuaryManager';
import { ConnectionState } from '../src/Core/EstuaryEvents';

@component
export class ExampleSayLine extends BaseScriptComponent {

    // ==================== Configuration (set in Inspector) ====================

    /**
     * Delay in seconds after connection before speaking the first line.
     * Gives the session time to fully establish.
     */
    @input
    @hint("Seconds to wait after connection before first line")
    delayBeforeFirstLine: number = 2.0;

    /**
     * Whether to automatically speak the first scripted line on connection.
     */
    @input
    @hint("Automatically speak the first line when connected")
    autoSpeakOnConnect: boolean = true;

    // ==================== Scripted Lines ====================

    /**
     * Edit these lines to customize what the character says.
     * Call sayNext() to advance through them.
     */
    private scriptedLines: string[] = [
        "Welcome to my shop, adventurer! I have wares if you have coin.",
        "That sword you're carrying looks like it's seen better days. I could fix it up for you.",
        "Come back anytime. I'll keep the forge warm.",
    ];

    // ==================== Private Members ====================

    private currentLineIndex: number = 0;
    private connected: boolean = false;

    // ==================== Lifecycle ====================

    onAwake() {
        print("[ExampleSayLine] Initializing...");
        print(`[ExampleSayLine] Auto-speak on connect: ${this.autoSpeakOnConnect}`);
        print(`[ExampleSayLine] Delay before first line: ${this.delayBeforeFirstLine}s`);
        print(`[ExampleSayLine] Scripted lines: ${this.scriptedLines.length}`);

        // Poll for connection state via EstuaryManager singleton.
        // This avoids any script execution order issues — we just check
        // each frame until the manager reports connected.
        const pollEvent = this.createEvent("UpdateEvent");
        pollEvent.bind(() => {
            const manager = EstuaryManager.instance;

            if (!this.connected && manager.isConnected) {
                this.connected = true;
                print("[ExampleSayLine] Connection detected!");
                pollEvent.enabled = false;
                this.onConnected();
            }
        });

        // Also listen for connection state changes in case we miss the initial connect
        try {
            const manager = EstuaryManager.instance;
            manager.on('connectionStateChanged', (state: ConnectionState) => {
                print(`[ExampleSayLine] Connection state: ${state}`);
                if (state === ConnectionState.Connected && !this.connected) {
                    this.connected = true;
                    pollEvent.enabled = false;
                    this.onConnected();
                }
            });
        } catch (e) {
            // Manager may not be initialized yet — the poll loop handles this
            print(`[ExampleSayLine] Manager not ready yet, using poll fallback`);
        }

        print("[ExampleSayLine] Ready — waiting for connection...");
    }

    // ==================== Public Methods ====================

    /**
     * Speak the next scripted line with TTS audio.
     * Wraps around to the first line after reaching the end.
     */
    sayNext(): void {
        if (!this.connected) {
            print("[ExampleSayLine] Cannot say line: not connected");
            return;
        }

        const line = this.scriptedLines[this.currentLineIndex];
        print(`[ExampleSayLine] Speaking line ${this.currentLineIndex + 1}/${this.scriptedLines.length}: "${line}"`);

        EstuaryManager.instance.sayLine(line);

        this.currentLineIndex = (this.currentLineIndex + 1) % this.scriptedLines.length;
    }

    /**
     * Send a text-only scripted line (no TTS audio).
     * Useful for silent narrative text, subtitles, or internal monologue.
     */
    sayTextOnly(): void {
        if (!this.connected) {
            print("[ExampleSayLine] Cannot say line: not connected");
            return;
        }

        const line = "This is a silent scripted line — delivered as text only, no audio.";
        print(`[ExampleSayLine] Sending text-only line: "${line}"`);

        EstuaryManager.instance.sayLine(line, true);
    }

    /**
     * Speak any arbitrary text with TTS.
     * @param text The text for the character to say
     * @param textOnly If true, text-only (no TTS audio). Default false.
     */
    say(text: string, textOnly: boolean = false): void {
        if (!this.connected) {
            print("[ExampleSayLine] Cannot say line: not connected");
            return;
        }

        print(`[ExampleSayLine] Speaking: "${text}" (textOnly=${textOnly})`);
        EstuaryManager.instance.sayLine(text, textOnly);
    }

    /**
     * Reset to the first scripted line.
     */
    resetLines(): void {
        this.currentLineIndex = 0;
        print("[ExampleSayLine] Reset to first line");
    }

    // ==================== Private Methods ====================

    private onConnected(): void {
        if (this.autoSpeakOnConnect) {
            print(`[ExampleSayLine] Will speak first line in ${this.delayBeforeFirstLine}s...`);

            let elapsed = 0;
            const delayEvent = this.createEvent("UpdateEvent");
            delayEvent.bind(() => {
                elapsed += getDeltaTime();
                if (elapsed >= this.delayBeforeFirstLine) {
                    delayEvent.enabled = false;
                    this.sayNext();
                }
            });
        }
    }
}
