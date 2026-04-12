/**
 * EstuaryTextConnection.ts
 *
 * Text-only connection to Estuary — no microphone, no audio output, no voice session.
 * This is the minimal example for text chat with an AI character.
 *
 * Setup in Lens Studio:
 * 1. Add an InternetModule to your scene
 * 2. Create a SceneObject with EstuaryCredentials script (set API key & character ID)
 * 3. Create a SceneObject and add this script
 * 4. Connect the InternetModule and credentials SceneObject to this script's inputs
 * 5. Run the scene — it will auto-connect
 *
 * This example does NOT require:
 * - MicrophoneRecorder
 * - DynamicAudioOutput / AudioComponent
 * - Voice Preset on your character
 * - EstuaryVoiceConnection
 *
 * To send messages at runtime, call:
 *   textConnection.sendMessage("Hello!")       — send a text message to the AI
 *   textConnection.sayLine("Greetings!")       — script a line (text-only, no TTS)
 *   textConnection.sayLineWithVoice("Hello!")  — script a line with TTS audio
 *                                                (character must have a Voice Preset)
 */

import { EstuaryCharacter } from '../src/Components/EstuaryCharacter';
import { EstuaryCredentials, IEstuaryCredentials, getCredentialsFromSceneObject } from '../src/Components/EstuaryCredentials';
import { EstuaryActionManager, EstuaryActions } from '../src/Components/EstuaryActionManager';
import { EstuaryManager } from '../src/Components/EstuaryManager';
import { EstuaryConfig } from '../src/Core/EstuaryConfig';
import { SessionInfo } from '../src/Models/SessionInfo';
import { BotResponse } from '../src/Models/BotResponse';

@component
export class EstuaryTextConnection extends BaseScriptComponent {

    // ==================== Configuration (set in Inspector) ====================

    /**
     * Reference to the EstuaryCredentials SceneObject.
     * This contains your API key, character ID, and other settings.
     * Create a SceneObject with EstuaryCredentials script and drag it here.
     */
    @input
    @hint("SceneObject with EstuaryCredentials script (contains API key & character ID)")
    credentialsObject: SceneObject;

    /** InternetModule for WebSocket connections (required for Lens Studio 5.9+) */
    @input
    @hint("Connect the InternetModule from your scene")
    internetModule: InternetModule;

    /**
     * Whether to automatically send the initial message on connection.
     */
    @input
    @hint("Automatically send initialMessage as a user message on connect")
    autoSendOnConnect: boolean = false;

    /**
     * User message to send on connection (if autoSendOnConnect is true).
     * Routed through the LLM + TTS pipeline like any other user message.
     */
    @input
    @hint("User message to send on connect (routed through LLM + TTS)")
    initialMessage: string = "";

    // ==================== Private Members ====================

    private credentials: IEstuaryCredentials | null = null;
    private character: EstuaryCharacter | null = null;
    private actionManager: EstuaryActionManager | null = null;
    private playerId: string = "";
    private updateEvent: SceneEvent | null = null;

    // ==================== Lifecycle ====================

    onAwake() {
        this.log("Initializing...");

        // Get credentials from the referenced SceneObject or singleton
        this.credentials = this.getCredentials();
        if (!this.credentials) {
            print("[EstuaryTextConnection] ERROR: No EstuaryCredentials found!");
            print("[EstuaryTextConnection] Either set credentialsObject input OR add EstuaryCredentials to your scene");
            return;
        }

        // Set up InternetModule for WebSocket connections (required for Lens Studio 5.9+)
        if (this.internetModule) {
            EstuaryManager.instance.internetModule = this.internetModule;
            this.log("InternetModule configured via EstuaryManager");
        } else {
            print("[EstuaryTextConnection] ERROR: InternetModule is required! Add it to your scene and connect it.");
            return;
        }

        // Get player ID from credentials (supports manual, persistent, or session-based IDs)
        if (this.credentials.userId && this.credentials.userId.length > 0) {
            this.playerId = this.credentials.userId;
            this.log(`Using User ID from credentials: ${this.playerId}`);
        } else {
            // Fallback to generated ID if credentials don't provide one
            this.playerId = "spectacles_" + Date.now().toString(36);
            this.log(`Using fallback generated User ID: ${this.playerId}`);
        }

        // Set up the update loop for send queue processing
        this.updateEvent = this.createEvent("UpdateEvent");
        this.updateEvent.bind(() => this.onUpdate());

        // Connect immediately — credentials and modules are already resolved
        this.connect();
    }

    /**
     * Get credentials from the referenced SceneObject or singleton.
     */
    private getCredentials(): IEstuaryCredentials | null {
        // First try the input SceneObject
        if (this.credentialsObject) {
            const creds = getCredentialsFromSceneObject(this.credentialsObject);
            if (creds) {
                this.log("Using credentials from credentialsObject input");
                return creds;
            }
        }

        // Fall back to singleton
        if (EstuaryCredentials.hasInstance) {
            this.log("Using credentials from EstuaryCredentials singleton");
            return EstuaryCredentials.instance;
        }

        return null;
    }

    onDestroy() {
        this.disconnect();
    }

    /**
     * Switch to a different character. Disconnects current, reconnects with new ID.
     */
    public switchCharacter(characterId: string): void {
        if (!this.credentials) {
            print("[EstuaryTextConnection] ERROR: No credentials for switchCharacter");
            return;
        }

        this.log("Switching to character: " + characterId);

        // Tear down old connection
        this.disconnect();

        // Update credentials
        this.credentials.characterId = characterId;

        // Reconnect with the new character ID
        this.connect();
    }

    // ==================== Connection ====================

    private connect(): void {
        if (!this.credentials) {
            print("[EstuaryTextConnection] ERROR: No credentials available!");
            return;
        }

        if (!this.credentials.characterId) {
            print("[EstuaryTextConnection] ERROR: characterId is required!");
            return;
        }

        this.log(`Connecting to ${this.credentials.serverUrl}...`);

        // Create the character
        this.character = new EstuaryCharacter(this.credentials.characterId, this.playerId);

        // Set up action manager for parsing action tags from responses
        this.actionManager = new EstuaryActionManager(this.character);
        this.actionManager.setCredentials(this.credentials);
        this.actionManager.debugLogging = this.credentials.debugMode;

        // Set up global action events - any script can now use EstuaryActions.on()
        EstuaryActions.setManager(this.actionManager);

        this.log("Action manager configured - EstuaryActions global events ready");

        // Set up event handlers
        this.setupEventHandlers();

        // Connect
        const config: EstuaryConfig = {
            serverUrl: this.credentials!.serverUrl,
            apiKey: this.credentials!.apiKey,
            characterId: this.credentials!.characterId,
            playerId: this.playerId,
            debugLogging: this.credentials!.debugMode
        };

        this.character.initialize(config);
    }

    private disconnect(): void {
        if (this.actionManager) {
            try {
                this.actionManager.dispose();
            } catch (e: any) {
                print('[EstuaryTextConnection] ActionManager cleanup error: ' + (e.message || e));
            }
            this.actionManager = null;
        }
        if (this.character) {
            try {
                this.character.dispose();
            } catch (e: any) {
                print('[EstuaryTextConnection] Character dispose error: ' + (e.message || e));
            }
            this.character = null;
        }
    }

    // ==================== Event Handlers ====================

    private setupEventHandlers(): void {
        if (!this.character) return;

        // Connected
        this.character.on('connected', (session: SessionInfo) => {
            this.log(`Connected! Session: ${session.sessionId}`);

            if (this.autoSendOnConnect && this.initialMessage.length > 0) {
                this.character!.sendText(this.initialMessage);
            }
        });

        // Disconnected
        this.character.on('disconnected', () => {
            this.log("Disconnected");
        });

        // AI response (text)
        this.character.on('botResponse', (response: BotResponse) => {
            if (response.isFinal) {
                print(`[AI] ${response.text}`);
            }
        });

        // Errors
        this.character.on('error', (error: string) => {
            print(`[EstuaryTextConnection] Error: ${error}`);
        });
    }

    // ==================== Update Loop ====================

    private onUpdate(): void {
        // ALWAYS process send queue every frame — protocol messages (pong, auth)
        // get stuck in the queue without tick() on Spectacles.
        // The 75ms min send gap is enforced inside processSendQueue().
        EstuaryManager.instance.tick();
    }

    // ==================== Public Methods ====================

    /** Send a text message to the AI character */
    sendMessage(text: string): void {
        if (this.character?.isConnected) {
            this.character.sendText(text);
        } else {
            print('[EstuaryTextConnection] Cannot send: not connected');
        }
    }

    /** Script the character to say a line (text-only, no TTS audio) */
    sayLine(text: string): void {
        if (this.character?.isConnected) {
            this.character.sayLine(text, true);
        } else {
            print('[EstuaryTextConnection] Cannot say line: not connected');
        }
    }

    /** Script the character to say a line with TTS audio (character must have a Voice Preset) */
    sayLineWithVoice(text: string): void {
        if (this.character?.isConnected) {
            this.character.sayLine(text, false);
        } else {
            print('[EstuaryTextConnection] Cannot say line: not connected');
        }
    }

    /** Get the character instance for advanced usage */
    getCharacter(): EstuaryCharacter | null {
        return this.character;
    }

    /** Get the action manager for subscribing to actions */
    getActionManager(): EstuaryActionManager | null {
        return this.actionManager;
    }

    // ==================== Utility ====================

    private log(message: string): void {
        if (this.credentials?.debugMode) {
            print(`[EstuaryTextConnection] ${message}`);
        }
    }
}
