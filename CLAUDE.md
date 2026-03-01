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
min_audio_sample_rate: 16000
max_audio_sample_rate: 16000           # Hardware-locked to 16kHz
```

## Parity Status

| Feature | Status | Notes |
|---------|--------|-------|
| text_chat | Implemented | Full parity |
| voice_websocket | Implemented | Base64 PCM over WebSocket (only voice option) |
| voice_livekit | Not available | Spectacles lacks WebRTC — voice_websocket is the only path |
| interrupts | Implemented | Full parity |
| audio_playback_tracking | Implemented | Full parity |
| vision_camera | Implemented | On-demand via CameraModule + VisionIntentDetector |
| video_streaming_livekit | Not available | No WebRTC |
| video_streaming_websocket | Not implemented | Could be added via `video_frame` event if needed |
| scene_graph | Not applicable | No AR world model on Spectacles |
| device_pose | Implemented | Via DeviceTracking |
| preferences | Implemented | Full parity |

## Architecture

```
src/
├── Components/              # Lens Studio ScriptComponents (user-facing)
│   ├── EstuaryManager           — Singleton coordinator
│   ├── EstuaryCharacter         — Per-character instance, EventEmitter pattern
│   ├── EstuaryMicrophone        — Audio capture with chunking
│   ├── EstuaryCredentials       — API key + character config
│   ├── EstuaryActionManager     — Parses action tags from bot responses
│   └── VisionIntentDetector     — Detects vision-related queries in speech
├── Core/                    # Low-level client logic
│   ├── EstuaryClient            — Socket.IO v4 client (manual protocol impl)
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

### No WebSocket in Preview
WebSocket connections do not work in Lens Studio's Preview mode. All network testing requires deploying to actual Spectacles hardware.

### InternetModule Initialization
`InternetModule` must be set via `setInternetModule()` before any connection attempt. The module is injected as a ScriptComponent input, not fetched programmatically.

### Audio Constraints
- Recording: 16kHz mono 16-bit PCM only (hardware limitation)
- Playback: 16kHz mono only
- Uses Lens Studio's `AudioTrackAsset` for both input and output
- Audio chunks are base64-encoded for WebSocket transport

### Vision
- Camera capture is on-demand via `camera_image` event
- `VisionIntentDetector` auto-detects phrases like "what do you see?" and triggers capture
- Server can also request capture via `camera_capture` event

## Code Style

- TypeScript with Lens Studio's module system
- EventEmitter pattern for component communication
- camelCase for methods and properties, PascalCase for classes
- Lens Studio decorator patterns: `@component`, `@input`
