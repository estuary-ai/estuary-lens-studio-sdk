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
 * 1. Make sure EstuaryVoiceConnection (or EstuaryCharacter) is set up in your scene
 * 2. Create a SceneObject (e.g., "SayLine Test")
 * 3. Add this script to the SceneObject
 * 4. Drag your EstuaryVoiceConnection SceneObject to the voiceConnection input
 * 5. Run the scene — the character will speak the first line after connecting
 *
 * To trigger additional lines at runtime, call:
 *   exampleSayLine.sayNext()         — speak the next scripted line (with TTS)
 *   exampleSayLine.sayTextOnly()     — send a text-only line (no audio)
 *   exampleSayLine.say("custom text") — speak any arbitrary text
 */

import { EstuaryCharacter } from '../src/Components/EstuaryCharacter';
import { BotResponse } from '../src/Models/BotResponse';
import { BotVoice } from '../src/Models/BotVoice';
import { SessionInfo } from '../src/Models/SessionInfo';

@component
export class ExampleSayLine extends BaseScriptComponent {

    // ==================== Configuration (set in Inspector) ====================

    /**
     * Reference to the SceneObject that has EstuaryVoiceConnection.
     * The script will find the EstuaryCharacter through it.
     *
     * Alternatively, you can set characterObject directly if you're
     * using EstuaryCharacter without EstuaryVoiceConnection.
     */
    @input
    @hint("SceneObject with EstuaryVoiceConnection script")
    voiceConnectionObject: SceneObject;

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

    private character: EstuaryCharacter | null = null;
    private currentLineIndex: number = 0;
    private connected: boolean = false;
    private firstLineTimer: number = -1;

    // ==================== Lifecycle ====================

    onAwake() {
        print("[ExampleSayLine] Initializing...");

        // Find the character from the voice connection
        this.character = this.findCharacter();
        if (!this.character) {
            print("[ExampleSayLine] ERROR: No EstuaryCharacter found!");
            print("[ExampleSayLine] Set voiceConnectionObject to your EstuaryVoiceConnection SceneObject");
            return;
        }

        this.setupEventListeners();
        print(`[ExampleSayLine] Ready with ${this.scriptedLines.length} scripted lines`);
    }

    // ==================== Public Methods ====================

    /**
     * Speak the next scripted line with TTS audio.
     * Wraps around to the first line after reaching the end.
     */
    sayNext(): void {
        if (!this.character || !this.connected) {
            print("[ExampleSayLine] Cannot say line: not connected");
            return;
        }

        const line = this.scriptedLines[this.currentLineIndex];
        print(`[ExampleSayLine] Speaking line ${this.currentLineIndex + 1}/${this.scriptedLines.length}: "${line}"`);

        this.character.sayLine(line);

        this.currentLineIndex = (this.currentLineIndex + 1) % this.scriptedLines.length;
    }

    /**
     * Send a text-only scripted line (no TTS audio).
     * Useful for silent narrative text, subtitles, or internal monologue.
     */
    sayTextOnly(): void {
        if (!this.character || !this.connected) {
            print("[ExampleSayLine] Cannot say line: not connected");
            return;
        }

        const line = "This is a silent scripted line — delivered as text only, no audio.";
        print(`[ExampleSayLine] Sending text-only line: "${line}"`);

        this.character.sayLine(line, true);
    }

    /**
     * Speak any arbitrary text with TTS.
     * @param text The text for the character to say
     * @param textOnly If true, text-only (no TTS audio). Default false.
     */
    say(text: string, textOnly: boolean = false): void {
        if (!this.character || !this.connected) {
            print("[ExampleSayLine] Cannot say line: not connected");
            return;
        }

        print(`[ExampleSayLine] Speaking: "${text}" (textOnly=${textOnly})`);
        this.character.sayLine(text, textOnly);
    }

    /**
     * Reset to the first scripted line.
     */
    resetLines(): void {
        this.currentLineIndex = 0;
        print("[ExampleSayLine] Reset to first line");
    }

    // ==================== Private Methods ====================

    private findCharacter(): EstuaryCharacter | null {
        if (!this.voiceConnectionObject) {
            return null;
        }

        // Look for EstuaryVoiceConnection script and get its character
        const scripts = this.voiceConnectionObject.getComponents("Component.ScriptComponent");
        for (let i = 0; i < scripts.length; i++) {
            const script = scripts[i] as any;
            if (typeof script.getCharacter === 'function') {
                const character = script.getCharacter();
                if (character) {
                    return character;
                }
            }
        }

        // The character may not be created yet (connection hasn't happened).
        // We'll try again when we detect connection via EstuaryManager events.
        return null;
    }

    private setupEventListeners(): void {
        // If character is already available, listen for events
        if (this.character) {
            this.subscribeToCharacter(this.character);
        }

        // Also set up a frame check to find the character if it wasn't ready yet
        const checkEvent = this.createEvent("UpdateEvent");
        checkEvent.bind(() => {
            if (!this.character) {
                this.character = this.findCharacter();
                if (this.character) {
                    print("[ExampleSayLine] Found character (delayed)");
                    this.subscribeToCharacter(this.character);
                    checkEvent.enabled = false;
                }
            } else if (!this.connected && this.character.isConnected) {
                // Character connected before we subscribed
                this.onConnected();
                checkEvent.enabled = false;
            } else if (this.connected) {
                checkEvent.enabled = false;
            }
        });
    }

    private subscribeToCharacter(character: EstuaryCharacter): void {
        character.on('connected', (session: SessionInfo) => {
            print(`[ExampleSayLine] Connected! Session: ${session.sessionId}`);
            this.onConnected();
        });

        character.on('botResponse', (response: BotResponse) => {
            if (response.isFinal && response.text) {
                print(`[ExampleSayLine] Character said: "${response.text}"`);
            }
        });

        character.on('voiceReceived', (voice: BotVoice) => {
            // Audio is handled by EstuaryVoiceConnection's DynamicAudioOutput.
            // This callback is just for logging/debugging.
            if (voice.chunkIndex === 0) {
                print(`[ExampleSayLine] Audio playback started (message: ${voice.messageId})`);
            }
        });

        character.on('error', (error: string) => {
            print(`[ExampleSayLine] Error: ${error}`);
        });

        // Check if already connected
        if (character.isConnected) {
            this.onConnected();
        }
    }

    private onConnected(): void {
        if (this.connected) return; // Prevent double-fire
        this.connected = true;

        if (this.autoSpeakOnConnect) {
            print(`[ExampleSayLine] Will speak first line in ${this.delayBeforeFirstLine}s...`);

            // Use a frame-based timer for the delay
            this.firstLineTimer = 0;
            const delayEvent = this.createEvent("UpdateEvent");
            delayEvent.bind(() => {
                this.firstLineTimer += getDeltaTime();
                if (this.firstLineTimer >= this.delayBeforeFirstLine) {
                    delayEvent.enabled = false;
                    this.sayNext();
                }
            });
        }
    }
}
