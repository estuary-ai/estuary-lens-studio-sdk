/**
 * Voice Chat Example for Estuary SDK in Lens Studio
 * 
 * This example demonstrates how to set up a basic voice conversation
 * with an Estuary AI character in Lens Studio for Spectacles.
 * 
 * Setup Instructions:
 * 1. Copy the Estuary SDK into your project's Scripts folder
 * 2. Create an Audio Output asset and an Audio Input asset in Lens Studio
 * 3. Create a new TypeScript script and copy this code
 * 4. Configure the input properties in the Inspector
 * 5. Set your API key and character ID
 * 
 * Note: This example shows the SDK usage pattern for Lens Studio.
 */

// Import from your local Estuary SDK folder
// Adjust the path based on where you placed the SDK files
import { EstuaryCharacter } from '../src/Components/EstuaryCharacter';
import { EstuaryAudioPlayer, AudioOutputControl } from '../src/Components/EstuaryAudioPlayer';
import { EstuaryMicrophone, AudioInputControl } from '../src/Components/EstuaryMicrophone';
import { EstuaryConfig } from '../src/Core/EstuaryConfig';
import { ConnectionState } from '../src/Core/EstuaryEvents';
import { SessionInfo } from '../src/Models/SessionInfo';
import { BotResponse } from '../src/Models/BotResponse';
import { SttResponse } from '../src/Models/SttResponse';

/**
 * Simple voice chat demo using Estuary SDK.
 * 
 * In a real Lens Studio script, you would use the @component decorator
 * and @input decorators for the audio assets.
 */
export class VoiceChatExample {
    // Configuration
    private characterId: string;
    private playerId: string;
    private config: EstuaryConfig;

    // SDK Components
    private character: EstuaryCharacter;
    private audioPlayer: EstuaryAudioPlayer;
    private microphone: EstuaryMicrophone;

    // State
    private isTalking: boolean = false;

    /**
     * Create a new VoiceChatExample.
     * @param characterId Character ID from Estuary dashboard
     * @param apiKey Your Estuary API key
     * @param serverUrl Estuary server URL
     */
    constructor(
        characterId: string,
        apiKey: string,
        serverUrl: string = 'https://api.estuary-ai.com'
    ) {
        this.characterId = characterId;
        this.playerId = this.generatePlayerId();

        // Create configuration
        this.config = {
            serverUrl,
            apiKey,
            characterId,
            playerId: this.playerId,
            debugLogging: true
        };

        // Create character
        this.character = new EstuaryCharacter(characterId, this.playerId);

        // Create audio components (will be configured with actual controls later)
        this.audioPlayer = new EstuaryAudioPlayer();
        this.microphone = new EstuaryMicrophone(this.character);

        // Set up event handlers
        this.setupEventHandlers();
    }

    /**
     * Initialize with Lens Studio audio controls.
     * Call this from your script's onAwake or similar lifecycle method.
     * @param audioOutput Audio output control from Lens Studio
     * @param audioInput Audio input control from Lens Studio
     */
    initialize(audioOutput: AudioOutputControl, audioInput?: AudioInputControl): void {
        // Configure audio player
        this.audioPlayer.setAudioOutput(audioOutput);
        this.audioPlayer.debugLogging = true;

        // Configure microphone if available
        if (audioInput) {
            this.microphone.setAudioInput(audioInput);
            this.microphone.debugLogging = true;
        }

        // Connect audio player to character
        this.character.audioPlayer = this.audioPlayer;
        this.character.microphone = this.microphone;

        // Initialize character with config
        this.character.initialize(this.config);

        print('[VoiceChatExample] Initialized. Waiting for connection...');
    }

    /**
     * Start talking (push-to-talk).
     * Call this when the user presses the talk button.
     */
    startTalking(): void {
        if (!this.character.isConnected) {
            print('[VoiceChatExample] Not connected yet!');
            return;
        }

        if (this.isTalking) {
            return;
        }

        this.isTalking = true;
        this.character.startVoiceSession();
        print('[VoiceChatExample] Recording started...');
    }

    /**
     * Stop talking (push-to-talk).
     * Call this when the user releases the talk button.
     */
    stopTalking(): void {
        if (!this.isTalking) {
            return;
        }

        this.isTalking = false;
        this.character.endVoiceSession();
        print('[VoiceChatExample] Recording stopped.');
    }

    /**
     * Toggle talking state.
     */
    toggleTalking(): void {
        if (this.isTalking) {
            this.stopTalking();
        } else {
            this.startTalking();
        }
    }

    /**
     * Send a text message to the AI.
     * @param message Message to send
     */
    sendMessage(message: string): void {
        if (!this.character.isConnected) {
            print('[VoiceChatExample] Not connected yet!');
            return;
        }

        print(`[VoiceChatExample] Sending: ${message}`);
        this.character.sendText(message);
    }

    /**
     * Process audio frames. Call this every frame from UpdateEvent.
     * @param frameSize Number of audio samples to process
     */
    update(frameSize: number = 1024): void {
        // Process microphone input
        if (this.isTalking) {
            this.microphone.processAudioFrame(frameSize);
        }

        // Process audio output
        this.audioPlayer.processAudioFrame();
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        this.character.dispose();
        this.audioPlayer.dispose();
        this.microphone.dispose();
    }

    // ==================== Private Methods ====================

    private setupEventHandlers(): void {
        // Character connected
        this.character.on('connected', (session: SessionInfo) => {
            print(`[VoiceChatExample] Connected! Session: ${session.sessionId}`);
            print('[VoiceChatExample] Ready to talk to the AI.');
        });

        // Character disconnected
        this.character.on('disconnected', () => {
            print('[VoiceChatExample] Disconnected from server.');
            this.isTalking = false;
        });

        // Bot response received
        this.character.on('botResponse', (response: BotResponse) => {
            if (response.isFinal) {
                print(`[VoiceChatExample] AI: ${response.text}`);
            }
        });

        // Speech-to-text result
        this.character.on('transcript', (response: SttResponse) => {
            if (response.isFinal) {
                print(`[VoiceChatExample] You: ${response.text}`);
            } else {
                print(`[VoiceChatExample] (transcribing) ${response.text}...`);
            }
        });

        // Error occurred
        this.character.on('error', (error: string) => {
            print(`[VoiceChatExample] Error: ${error}`);
        });

        // Connection state changed
        this.character.on('connectionStateChanged', (state: ConnectionState) => {
            print(`[VoiceChatExample] Connection state: ${state}`);
        });

        // Audio playback events
        this.audioPlayer.on('playbackStarted', () => {
            print('[VoiceChatExample] AI is speaking...');
        });

        this.audioPlayer.on('playbackComplete', () => {
            print('[VoiceChatExample] AI finished speaking.');
        });
    }

    private generatePlayerId(): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 10);
        return `spectacles_${timestamp}_${random}`;
    }
}

// Export for use in other scripts
export default VoiceChatExample;

/**
 * ============================================================
 * LENS STUDIO SCRIPT TEMPLATE
 * ============================================================
 * 
 * Copy the code below into a new TypeScript file in your
 * Lens Studio project to create a working voice chat experience.
 * 
 * Remember to:
 * 1. Replace YOUR_API_KEY and YOUR_CHARACTER_ID with your actual values
 * 2. Create Audio Output and Audio Input assets in Lens Studio
 * 3. Add this script to a SceneObject
 * 4. Connect the audio assets in the Inspector
 * 
 * ============================================================

// --- START COPY HERE ---

import { EstuaryCharacter } from './Estuary/Components/EstuaryCharacter';
import { EstuaryAudioPlayer, AudioOutputControl } from './Estuary/Components/EstuaryAudioPlayer';
import { EstuaryMicrophone, AudioInputControl } from './Estuary/Components/EstuaryMicrophone';
import { EstuaryConfig } from './Estuary/Core/EstuaryConfig';
import { BotResponse } from './Estuary/Models/BotResponse';
import { SttResponse } from './Estuary/Models/SttResponse';
import { SessionInfo } from './Estuary/Models/SessionInfo';

@component
export class EstuaryVoiceChat extends BaseScriptComponent {
    
    // Configure in Inspector
    @input
    audioOutput: AudioTrackAsset;
    
    @input
    audioInput: AudioTrackAsset;
    
    // === CONFIGURATION - REPLACE WITH YOUR VALUES ===
    private readonly SERVER_URL = 'https://api.estuary-ai.com';
    private readonly API_KEY = 'YOUR_API_KEY_HERE';
    private readonly CHARACTER_ID = 'YOUR_CHARACTER_ID_HERE';
    
    private character: EstuaryCharacter;
    private audioPlayer: EstuaryAudioPlayer;
    private microphone: EstuaryMicrophone;
    private isRecording: boolean = false;
    
    onAwake() {
        const playerId = 'spectacles_' + Date.now().toString(36);
        
        // Create components
        this.character = new EstuaryCharacter(this.CHARACTER_ID, playerId);
        
        if (this.audioOutput) {
            const outputControl = this.audioOutput.control as AudioOutputControl;
            this.audioPlayer = new EstuaryAudioPlayer(outputControl);
            this.character.audioPlayer = this.audioPlayer;
        }
        
        if (this.audioInput) {
            this.microphone = new EstuaryMicrophone(this.character);
            const inputControl = this.audioInput.control as AudioInputControl;
            this.microphone.setAudioInput(inputControl);
            this.character.microphone = this.microphone;
        }
        
        // Subscribe to events
        this.character.on('connected', (s: SessionInfo) => print('Connected: ' + s.sessionId));
        this.character.on('botResponse', (r: BotResponse) => { if (r.isFinal) print('AI: ' + r.text); });
        this.character.on('transcript', (r: SttResponse) => { if (r.isFinal) print('You: ' + r.text); });
        this.character.on('error', (e: string) => print('Error: ' + e));
        
        // Connect
        const config: EstuaryConfig = {
            serverUrl: this.SERVER_URL,
            apiKey: this.API_KEY,
            characterId: this.CHARACTER_ID,
            playerId: playerId,
            debugLogging: true
        };
        this.character.initialize(config);
    }
    
    // Call from button press
    startRecording() {
        if (this.character.isConnected && !this.isRecording) {
            this.isRecording = true;
            this.character.startVoiceSession();
        }
    }
    
    // Call from button release
    stopRecording() {
        if (this.isRecording) {
            this.isRecording = false;
            this.character.endVoiceSession();
        }
    }
    
    onUpdate() {
        if (this.microphone && this.isRecording) {
            this.microphone.processAudioFrame(1024);
        }
        if (this.audioPlayer) {
            this.audioPlayer.processAudioFrame();
        }
    }
}

// --- END COPY HERE ---

 */





