# Estuary Lens Studio SDK

TypeScript SDK for integrating Estuary AI characters with voice and text chat capabilities into Snapchat Lens Studio projects for Spectacles.

## Features

- **Text Chat**: Send text messages to AI characters and receive responses
- **Voice Chat**: Real-time voice conversations with AI characters
- **Streaming Responses**: Low-latency streaming text and audio responses
- **Conversation Persistence**: Player conversations are automatically saved
- **WebSocket Communication**: Built-in Socket.IO v4 protocol implementation
- **TypeScript Support**: Full type definitions for Lens Studio development

## Requirements

- Lens Studio 5.0 or later
- Spectacles (5th Generation) for voice features
- An Estuary API key (get one at [app.estuary-ai.com](https://app.estuary-ai.com))

## Installation

### Manual Installation

1. Copy the `src` folder contents to your Lens Studio project's scripts directory
2. Import the modules you need in your scripts

### Via npm (for TypeScript projects)

```bash
npm install @estuary-ai/lens-studio-sdk
```

## Quick Start

### 1. Create Configuration

```typescript
import { EstuaryConfig } from './Estuary/Core/EstuaryConfig';

const config: EstuaryConfig = {
    serverUrl: 'https://api.estuary-ai.com',
    apiKey: 'your-api-key',
    characterId: 'your-character-uuid',
    playerId: 'unique-player-id',
    debugLogging: true
};
```

### 2. Set Up Character

```typescript
import { EstuaryCharacter } from './Estuary/Components/EstuaryCharacter';

const character = new EstuaryCharacter(
    'your-character-uuid',
    'unique-player-id'
);

// Subscribe to events
character.on('connected', (session) => {
    print(`Connected! Session: ${session.sessionId}`);
});

character.on('botResponse', (response) => {
    if (response.isFinal) {
        print(`AI: ${response.text}`);
    }
});

// Initialize and connect
character.initialize(config);
```

### 3. Send Messages

```typescript
// Send text
character.sendText('Hello, how are you?');
```

### 4. Enable Voice Chat

**RECOMMENDED**: Use `MicrophoneRecorder` from `RemoteServiceGateway.lspkg` (same as official Gemini example).

```typescript
import { EstuaryAudioPlayer } from './Estuary/Components/EstuaryAudioPlayer';
import { EstuaryMicrophone, MicrophoneRecorder } from './Estuary/Components/EstuaryMicrophone';

// Set up audio player for voice responses
const audioPlayer = new EstuaryAudioPlayer(audioOutputControl);
character.audioPlayer = audioPlayer;

// Set up microphone for voice input using MicrophoneRecorder (RECOMMENDED)
// MicrophoneRecorder uses EVENT-BASED audio delivery - works in simulator!
const microphone = new EstuaryMicrophone(character);
microphone.setMicrophoneRecorder(microphoneRecorder);
character.microphone = microphone;

// Start voice session
character.startVoiceSession();

// NOTE: No need to call processAudioFrame() when using MicrophoneRecorder!
// Audio is delivered via events automatically.

// For audio output playback, still need update loop:
function onUpdate() {
    audioPlayer.processAudioFrame();
}

// End voice session
character.endVoiceSession();
```

**Setting up MicrophoneRecorder in Lens Studio (RECOMMENDED):**
1. Import `RemoteServiceGateway.lspkg` into your project
2. Add a `MicrophoneRecorder` SceneObject to your scene
3. Assign it to your script's `@input microphoneRecorder` property
4. The MicrophoneRecorder uses event-based audio delivery (works reliably!)

**Alternative: Audio From Microphone asset (polling-based, less reliable):**
1. In Asset Browser, click "+" → Audio → **Audio From Microphone**
2. Assign this asset to your script's `@input microphoneAudio` property
3. Call `microphone.processAudioFrame(1024)` in your update loop

## Complete Example

See [Examples/SimpleAutoConnect.ts](Examples/SimpleAutoConnect.ts) for a complete implementation.

**Lens Studio Setup (RECOMMENDED - using MicrophoneRecorder):**
1. Import `RemoteServiceGateway.lspkg` into your project
2. Add an InternetModule to your scene (required for WebSocket)
3. Add a `MicrophoneRecorder` SceneObject (from RemoteServiceGateway)
4. Add an Audio Track asset for output

```typescript
import { EstuaryCharacter } from './Estuary/Components/EstuaryCharacter';
import { EstuaryAudioPlayer } from './Estuary/Components/EstuaryAudioPlayer';
import { EstuaryMicrophone, MicrophoneRecorder } from './Estuary/Components/EstuaryMicrophone';
import { setInternetModule } from './Estuary/Core/EstuaryClient';

@component
export class MyLens extends BaseScriptComponent {
    @input audioOutput: AudioTrackAsset;
    // RECOMMENDED: MicrophoneRecorder from RemoteServiceGateway.lspkg
    @input microphoneRecorder: SceneObject;
    @input internetModule: InternetModule;
    
    private character: EstuaryCharacter;
    private audioPlayer: EstuaryAudioPlayer;
    private microphone: EstuaryMicrophone;
    
    onAwake() {
        // Set up InternetModule (required for WebSocket)
        setInternetModule(this.internetModule);
        
        // Create and configure components
        this.character = new EstuaryCharacter('char-id', 'player-id');
        this.audioPlayer = new EstuaryAudioPlayer(this.audioOutput.control);
        
        // Set up microphone with MicrophoneRecorder (EVENT-BASED - RECOMMENDED)
        this.microphone = new EstuaryMicrophone(this.character);
        const recorder = (this.microphoneRecorder as any).api as MicrophoneRecorder;
        this.microphone.setMicrophoneRecorder(recorder);
        
        // Connect components
        this.character.audioPlayer = this.audioPlayer;
        this.character.microphone = this.microphone;
        
        // Subscribe to events
        this.character.on('connected', () => {
            this.character.startVoiceSession();
            this.microphone.startRecording();
        });
        this.character.on('botResponse', (r) => print(`AI: ${r.text}`));
        
        // Initialize
        this.character.initialize({
            serverUrl: 'https://api.estuary-ai.com',
            apiKey: 'your-key',
            characterId: 'char-id',
            playerId: 'player-id'
        });
    }
    
    onUpdate() {
        // Only need to process audio output - microphone uses events!
        this.audioPlayer.processAudioFrame();
    }
}
```

## Components

### EstuaryManager

Singleton manager that handles the connection to Estuary servers.

| Property | Description |
|----------|-------------|
| `config` | Reference to EstuaryConfig |
| `isConnected` | Whether the SDK is connected |
| `connectionState` | Current connection state |

### EstuaryCharacter

Represents an AI character for conversations.

| Property | Description |
|----------|-------------|
| `characterId` | Character UUID from Estuary dashboard |
| `playerId` | Unique player identifier |
| `isConnected` | Whether character is connected |
| `isVoiceSessionActive` | Whether voice session is active |

| Event | Description |
|-------|-------------|
| `connected` | Fired when session is established |
| `disconnected` | Fired when connection is lost |
| `botResponse` | Fired when text response received |
| `voiceReceived` | Fired when voice audio received |
| `transcript` | Fired when STT result received |

### EstuaryMicrophone

Handles microphone input for voice chat.

**RECOMMENDED**: Use `MicrophoneRecorder` from `RemoteServiceGateway.lspkg` for event-based audio delivery.

| Property | Description |
|----------|-------------|
| `targetCharacter` | Character to send audio to |
| `sampleRate` | Recording sample rate (16000) |
| `streamImmediately` | Send audio as received (default: true, lowest latency) |
| `chunkDurationMs` | Audio chunk size in ms (used when streamImmediately=false) |
| `vadThreshold` | Voice activity threshold |
| `generateTestTone` | Generate 440Hz test tone instead of mic (for testing) |

| Method | Description |
|--------|-------------|
| `setMicrophoneRecorder(recorder)` | Set MicrophoneRecorder (RECOMMENDED - event-based) |
| `setMicrophoneProvider(provider)` | Set MicrophoneAudioProvider (polling-based fallback) |
| `setAudioInput(control)` | Set audio input (legacy) |
| `processAudioFrame(frameSize)` | Call every frame (not needed with MicrophoneRecorder) |

### EstuaryAudioPlayer

Handles playback of AI voice responses.

| Property | Description |
|----------|-------------|
| `sampleRate` | Playback sample rate (24000) |
| `isPlaying` | Whether audio is playing |
| `autoInterrupt` | Stop on new audio |

| Event | Description |
|-------|-------------|
| `playbackStarted` | Audio playback begins |
| `playbackComplete` | Audio playback ends |

## Audio Format

The SDK uses the following audio format:

- **Recording**: 16,000 Hz, Mono, 16-bit PCM
- **Playback**: 24,000 Hz, Mono, 16-bit PCM
- **Encoding**: Base64 for transmission

## Privacy Considerations

When using voice features on Spectacles:

1. WebSocket connections may require extended permissions
2. Microphone access requires user consent
3. See Snap's privacy guidelines for Spectacles

## Troubleshooting

### Connection Issues

1. Verify your API key is correct
2. Check that the server URL is accessible
3. Ensure WebSocket connections are allowed

### Audio Issues

1. Confirm Audio Input/Output assets are configured
2. Check sample rates match (16kHz input, 24kHz output)
3. Verify microphone permissions

### Performance

- Audio processing happens each frame
- Use appropriate chunk sizes (100ms recommended)
- Enable debug logging to diagnose issues

## API Reference

### EstuaryClient

Low-level WebSocket client with Socket.IO v4 protocol.

```typescript
const client = new EstuaryClient();

await client.connect(serverUrl, apiKey, characterId, playerId);
await client.sendText('Hello');
await client.streamAudio(base64Audio);
await client.disconnect();
```

### Utilities

```typescript
import { encodeAudio, decodeAudio } from './Estuary/Utilities/Base64Helper';
import { floatToPCM16, pcm16ToFloat } from './Estuary/Utilities/AudioConverter';

// Convert audio samples
const base64 = encodeAudio(floatSamples);
const samples = decodeAudio(base64);
```

## Support

- Documentation: [docs.estuary-ai.com](https://docs.estuary-ai.com)
- Discord: [discord.gg/estuary](https://discord.gg/estuary)
- Email: support@estuary-ai.com

## License

MIT License - see [LICENSE](LICENSE) for details.





