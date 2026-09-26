# Estuary Lens Studio SDK

TypeScript SDK for integrating Estuary AI characters with voice and text chat capabilities into Snapchat Lens Studio projects for Spectacles.

## Features

- **Text Chat**: Send text messages to AI characters and receive responses
- **Voice Chat**: Continuous voice and server-buffered push-to-talk
- **Conversation Events**: Typed quota, moderation, memory, delegation, result and timing events
- **Generated Characters**: Optional rigged GLBs and local animation clips
- **Streaming Responses**: Low-latency streaming text and audio responses
- **Conversation Persistence**: Player conversations are automatically saved
- **WebSocket Communication**: Built-in Socket.IO v4 protocol implementation
- **TypeScript Support**: Full type definitions for Lens Studio development

## Example Lenses
- [Estuary Lens Studio template](https://github.com/estuary-ai/estuary-snap-spectacles-template)
- [Character generation demo](https://github.com/estuary-ai/estuary-snap-spectacles-character-gen-demo)

## Requirements

- Lens Studio 5.9+ target
- Snap Spectacles; this SDK does not target mobile Snapchat lenses
- An Estuary API key (get one at [app.estuary-ai.com](https://app.estuary-ai.com))

## Installation

### Manual Installation

1. Copy the `src` folder contents to your Lens Studio project's scripts directory
2. Import the modules you need in your scripts

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
import { EstuaryManager } from './Estuary/Components/EstuaryManager';

// internetModule is an InternetModule asset assigned to your host script.
EstuaryManager.instance.internetModule = internetModule;

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
// Call after the connected event. Omit the flag to keep the server default.
character.sendText('Hello, how are you?');
character.sendText('Reply without speech', true);
```

### 4. Enable Voice Chat

Add `MicrophoneRecorder` and `DynamicAudioOutput` from Snap's RemoteServiceGateway package to the scene. Pass those component instances to the SDK:

```typescript
import { EstuaryMicrophone } from './Estuary/Components/EstuaryMicrophone';
import { EstuaryPlaybackTracker } from './Estuary/Components/EstuaryPlaybackTracker';

const microphone = new EstuaryMicrophone(character);
microphone.setMicrophoneRecorder(microphoneRecorder);
character.microphone = microphone;
const playback = new EstuaryPlaybackTracker(character, dynamicAudioOutput);

// Start after connected. Capture begins after the server's voice_started event.
character.startVoiceSession();

// Call from the host script's UpdateEvent.
function onUpdate() {
    EstuaryManager.instance.tick();
    playback.tick();
}

// On user stop:
character.endVoiceSession();
```

For push-to-talk, use `beginPushToTalk()` on press and `endPushToTalk()` on release. Reconnect to switch from PTT back to continuous voice. Dispose the microphone and character when the host is destroyed; the playback tracker follows character disposal.

The default adapter plays audio and handles cancellation using the server's completion estimate. Exact completion reporting requires a verified native playout clock. See [conversation parity usage and limits](docs/conversation-parity.md).

## Complete Examples

- [EstuaryVoiceConnection.ts](Examples/EstuaryVoiceConnection.ts): hardware discovery, voice, playback, timeouts and cleanup.
- [ConversationResults.ts](Examples/ConversationResults.ts): optional task status, endpoint image and citation card.

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

| Property | Description |
|----------|-------------|
| `targetCharacter` | Character to send audio to |
| `sampleRate` | Recording sample rate (16000) |
| `isRecording` | Whether microphone capture is active |

### EstuaryPlaybackTracker

Connects `voiceReceived` to `DynamicAudioOutput`, cancels interrupted/redacted audio, and optionally reports completion using a verified playout clock. Call `tick()` from the host update loop. Without a clock it sends no fabricated completion reports.

### EstuaryClipPlayer

Connects `clientAction` to a native `AnimationPlayer`. It resolves exact clip names or a unique suffix such as `wave` → `preset:biped:wave`. See [rigged model usage](docs/conversation-parity.md#rigged-models-and-local-clips).

## Audio Format

The SDK uses the following audio format:

- **Recording**: 16,000 Hz, Mono, 16-bit PCM
- **Playback**: 24,000 Hz preferred, Mono, 16-bit PCM (match the negotiated rate)
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

client.connect(serverUrl, apiKey, characterId, playerId);
// Wait for sessionConnected before sending. Call client.tick() each UpdateEvent.
client.sendText('Hello');
client.disconnect();
```

### Additional APIs

See [conversation parity](docs/conversation-parity.md) for typed events, result cards, rigged generation, playback-clock requirements and legacy timer injection.

## Support

- Documentation: [docs.estuary-ai.com](https://docs.estuary-ai.com)
- Discord: [discord.gg/estuary](https://discord.gg/estuary)
- Email: spencer@estuary-ai.com

## License

MIT License - see [LICENSE](LICENSE) for details.
