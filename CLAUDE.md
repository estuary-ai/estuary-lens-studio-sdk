# Estuary Lens Studio SDK — CLAUDE.md

## Overview

Lens Studio SDK for the Estuary real-time AI conversation platform. Targets **Snap Spectacles only** — not compatible with mobile Snapchat lenses.

**Language:** TypeScript (Lens Studio scripting)
**Target:** Lens Studio 5.9+ / Spectacles hardware
**Reference:** https://developers.snap.com/spectacles/home

## SDK Contract

This SDK implements the Estuary SDK API Contract defined in `SDK_CONTRACT.md` at the repository root. Always reference that file for the canonical API surface. When the contract changes, this SDK must be updated to match for all features within its platform capabilities.

## Platform Capabilities

```yaml
transport_websocket: true              # InternetModule.createWebSocket() (LS 5.9+)
transport_livekit_webrtc: false        # Spectacles has NO WebRTC support
audio_recording: true                  # AudioTrackAsset, 16kHz mono only
audio_playback: true                   # AudioTrackAsset, 16kHz mono only
camera_capture: true                   # CameraModule — on-demand capture
livekit_video: false                   # No WebRTC, no LiveKit video
scene_graph: false                     # Not applicable on Spectacles
device_pose: true                      # DeviceTracking module
min_audio_sample_rate: 16000           # Recording: hardware-locked to 16kHz
max_audio_sample_rate: 24000           # Playback: 24kHz preferred TTS default
default_playback_sample_rate: 24000    # TTS audio generated at 24kHz
```

## Parity Status

| Feature | Status | Notes |
|---------|--------|-------|
| text_chat | Implemented | Full parity |
| say_line | Implemented | `EstuaryClient.sayLine(text, textOnly?)` emits `say_line` with `text_only` flag |
| voice_websocket | Implemented | Base64 PCM over WebSocket (only voice option) |
| voice_push_to_talk | Implemented | PTT semantics available via `startVoiceMode()` / `stopVoiceMode()` — no separate API, client drives the recording window |
| voice_livekit | Not available | Spectacles lacks WebRTC — voice_websocket is the only path |
| interrupts | Implemented | `client_interrupt` emitted via `EstuaryCharacter.interrupt()` / `EstuaryManager.sendClientInterrupt()`; inbound `interrupt` parsed with `message_id` / `reason` / `interrupted_at` |
| audio_playback_tracking | Implemented | Full parity |
| vision_camera | Implemented | On-demand via CameraModule |
| video_streaming_livekit | Not available | No WebRTC |
| video_streaming_websocket | Not implemented | Could be added via `video_frame` event if needed |
| scene_graph | Not applicable | No AR world model on Spectacles |
| device_pose | Implemented | Via DeviceTracking |
| memory_push | Implemented | `memory_updated` event forwarded as `memoryUpdated` on EstuaryClient (raw payload; `new_memories` uses camelCase per contract) |
| preferences | Not implemented | No update_preferences event or enableVisionAcknowledgment handling |
| http_client | Implemented | Image-to-character (JSON+base64), model polling, character listing |
| image_to_character | Implemented | Via JSON+base64 (no multipart/form-data on Spectacles) |
| model_polling | Implemented | Exponential backoff 2s-10s |
| character_listing | Implemented | Paginated GET /api/v1/characters |
| glb_download | Implemented | downloadAndInstantiateGlb() on EstuaryHttpClient; uses InternetModule + RemoteMediaModule + GltfAsset pipeline |
| session_rejected | Documented (not implemented) | Event documented in SDK_CONTRACT.md per quick-task 260416-jta (concurrent session cap MVP on share tokens). Gateway emits `session_rejected` with `reason: "concurrent_limit"` then disconnects; Spectacles SDK currently treats this as a generic disconnect. Client handler + user-visible message surfacing deferred until share-token flows go consumer-facing. |

## Architecture

```
src/
├── Components/              # Lens Studio ScriptComponents (user-facing)
│   ├── EstuaryManager           — Singleton coordinator
│   ├── EstuaryCharacter         — Per-character instance, EventEmitter pattern
│   ├── EstuaryMicrophone        — Audio capture with chunking
│   ├── EstuaryCredentials       — API key + character config
│   └── EstuaryActionManager     — Parses action tags from bot responses
├── Core/                    # Low-level client logic
│   ├── EstuaryClient            — Socket.IO v4 client (manual protocol impl)
│   ├── EstuaryHttpClient        — REST API client (image-to-character, model polling, characters)
│   ├── EstuaryConfig            — Configuration holder
│   └── EstuaryEvents            — Event name constants
├── Models/                  # Data models matching SDK_CONTRACT.md shapes
└── Utilities/
    └── AudioConverter           — PCM encoding/decoding for Spectacles audio
```

## Platform Quirks — CRITICAL

These are non-negotiable constraints imposed by the Spectacles hardware and Lens Studio runtime:

### WebSocket Send Queue
Lens Studio's WebSocket implementation concatenates rapidly-sent messages, causing protocol corruption. The `EstuaryClient` enforces a **100ms minimum gap** between WebSocket sends via an internal queue. Never bypass this.

### InternetModule Initialization
`InternetModule` must be set via `EstuaryManager.instance.internetModule = module` before any connection attempt. Example scripts (EstuaryVoiceConnection, EstuaryTextConnection) accept it as an `@input` and pass it to EstuaryManager. The low-level `setInternetModule()` in EstuaryClient still works but is considered internal.

### Audio Constraints
- Recording: 16kHz mono 16-bit PCM only (hardware limitation)
- Playback: 24kHz mono preferred (TTS default sample rate)
- Uses Lens Studio's `AudioTrackAsset` for both input and output
- Audio chunks are base64-encoded for WebSocket transport

### Vision
- Camera capture is on-demand via `camera_image` event
- Server can request capture via `camera_capture` event

## Code Style

- TypeScript with Lens Studio's module system
- EventEmitter pattern for component communication
- camelCase for methods and properties, PascalCase for classes
- Lens Studio decorator patterns: `@component`, `@input`
