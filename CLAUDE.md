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
| say_line | Implemented | REQUIRED (contract v1.0, promoted from OPTIONAL 2026-06-06). `EstuaryClient.sayLine(text, textOnly?)` emits `say_line` with `text_only` flag |
| voice_websocket | Implemented | Base64 PCM over WebSocket (only voice option) |
| voice_push_to_talk | Implemented | PTT semantics available via `startVoiceMode()` / `stopVoiceMode()` — no separate API, client drives the recording window |
| voice_livekit | Not available | Spectacles lacks WebRTC — voice_websocket is the only path |
| interrupts | Implemented | `client_interrupt` emitted via `EstuaryCharacter.interrupt()` / `EstuaryManager.sendClientInterrupt()`; inbound `interrupt` parsed with `message_id` / `reason` / `interrupted_at` |
| client_action | Implemented | Typed in-world action calls (SCRUM-202, contract v1.9), fire-on-arrival per contract (not synced to TTS playback). Forwarding: `EstuaryClient` parses `client_action` → `clientAction` → `EstuaryManager` → `IEstuaryCharacterHandler.handleClientAction?` (optional, backward compatible) → `EstuaryCharacter` re-emits `clientAction` → `EstuaryActionManager` runs the SAME strictMode filter + dispatch as the tag path, so the existing `actionTriggered` / `action:{name}` / `actionsParsed` callbacks fire unchanged — integrators see no API change. `ParsedAction` gains additive optional `params` (argument values stringified to match legacy XML attribute behavior); for typed events `tag` holds a synthesized name-only `<action name="..." />`. This makes parameterized actions work on Spectacles for the FIRST time — the legacy regex only matched name-only tags. The legacy XML tag parser is retained but dormant during the deprecation window (fires only on stray tags still in `bot_response.text`); remove in a follow-up release per SDK_CONTRACT.md migration notes. |
| audio_playback_tracking | Implemented | Full parity |
| vision_camera | Implemented | On-demand via CameraModule |
| video_streaming_livekit | Not available | No WebRTC |
| video_streaming_websocket | Not implemented | Could be added via `video_frame` event if needed |
| scene_graph | Not applicable | No AR world model on Spectacles |
| device_pose | Implemented | Via DeviceTracking |
| memory_push | Implemented | `memory_updated` event forwarded as `memoryUpdated` on EstuaryClient (raw payload; `new_memories` uses camelCase per contract) |
| motive_push (v1.7) | Not implemented | `motive_updated` (snake_case, precedes `memory_updated`) is additive/OPTIONAL; no Spectacles use case yet — the private motive is owner/director-facing, not player-facing. Add a `motiveUpdated` forward next to `memoryUpdated` if a lens ever needs it. Character motive REST (`/api/v1/characters/{id}/motive`) and simulation motives are likewise unwrapped (no simulation surface in this SDK). |
| preferences | Not implemented | No update_preferences event or enableVisionAcknowledgment handling |
| http_client | Implemented | Image-to-character (JSON+base64), model polling, character listing |
| image_to_character | Implemented | Via JSON+base64 (no multipart/form-data on Spectacles) |
| model_polling | Implemented | Exponential backoff 2s-10s |
| character_listing | Implemented | Paginated GET /api/v1/characters |
| glb_download | Implemented | downloadAndInstantiateGlb() on EstuaryHttpClient; uses InternetModule + RemoteMediaModule + GltfAsset pipeline |
| session_timeout | Implemented | Server idle-timeout (no conversation activity). Suppression exists at BOTH reconnect layers: `EstuaryClient` flags the close as intentional (`_serverEndedSession`) so its `autoReconnect` stays quiet, AND `EstuaryCharacter` (which does its own reconnection in `handleDisconnected` — the manager disables client-level reconnect by design) skips `_autoReconnect` via its own `_serverEndedSession` flag set in `handleSessionTimeout`. Without the character-layer flag the reap loops: reconnect → re-auth → billed resources → reaped again. Forwarded client → manager → character (`IEstuaryCharacterHandler.handleSessionTimeout?`, optional) and re-emitted as `sessionTimeout` on all three. Character also stops the mic. Resume = explicit `connect()` on user intent (example: `EstuaryVoiceConnection.reconnect()`, wired to tap). |
| voice_timeout | Implemented | Server voice-lane idle release (SDK_CONTRACT.md). No LiveKit on Spectacles, but this ALSO applies to WebSocket voice: after no user speech for `VOICE_IDLE_TIMEOUT_S` (while e.g. text keeps the session alive), the server emits `voice_timeout` and closes the STT stream, KEEPING the socket. `EstuaryClient` re-emits `voiceTimeout` (raw contract payload; deliberately does NOT touch the `_serverEndedSession` reconnect-suppression flag — no disconnect follows, unlike `session_timeout`); `EstuaryManager` forwards to the active character (`IEstuaryCharacterHandler.handleVoiceTimeout?` — optional for backward compat) and re-emits; `EstuaryCharacter.handleVoiceTimeout` stops the mic, clears `_isVoiceSessionActive` (no more audio into the closed stream), and re-emits `voiceTimeout` for the app. No `stop_voice` is sent (server side already released). Resume = `startVoiceSession()` on user intent — recommended UX is the auto-mute illusion. |
| session_rejected | Documented (not implemented) | Event documented in SDK_CONTRACT.md per quick-task 260416-jta (concurrent session cap MVP on share tokens). Gateway emits `session_rejected` with `reason: "concurrent_limit"` then disconnects; Spectacles SDK currently treats this as a generic disconnect. Client handler + user-visible message surfacing deferred until share-token flows go consumer-facing. |
| encounter | Implemented | `EstuaryManager.startEncounter()` (REST) + `subscribeEncounter()` + `onEncounterMessage` / `onEncounterVoice` / `onEncounterEnd`; voice playback requires consumer to wire two `DynamicAudioOutput` instances (one per speaker) — see SDK_CONTRACT.md §Features > encounter. Inworld characters fall back to default ElevenLabs voice for MVP. NOTE: introduces a new convention — direct `EventEmitter` forwarders on `EstuaryManager` (prior features dispatch through `IEstuaryCharacterHandler`). |
| body_animation_stream | Not implemented | Backend wire is 63-bone MHR LOCAL quats (`bot_pose`, `session_info` body.rig `"mhr63"`, 2026-07-02; SMPL-X 52-bone wire retired). No Spectacles body-rig consumer exists, and 30 fps × 63-bone JSON frames are heavy for the Spectacles WebSocket budget (see Platform Quirks: send queue). The Unreal SDK is the only body-animation consumer. |
| bind_pose | Retired | Server event deleted 2026-07-02 (MHR63 rig-native model needs no client bind). Never implemented here — do not add. |
| turn_metrics | Not implemented | OPTIONAL/debug event; latency gizmo is web-frontend only. |
| simulation_v1 | Not implemented | Public Simulation API (SDK_CONTRACT.md §REST API — Simulation (v1), contract v1.4–1.6): worlds/instances REST + `/sim-v1` live streaming + per-instance world-view document + world destroy/memory-clear session isolation (v1.6). Unity is the reference SDK implementation (2026-07-18). Feasible on Spectacles (InternetModule REST + the existing Socket.IO client can join another namespace) but deferred — no Spectacles use case yet; server-to-server orchestration usually owns world/instance management, with the glasses as a viewer at most. |

## Architecture

```
src/
├── Components/              # Lens Studio ScriptComponents (user-facing)
│   ├── EstuaryManager           — Singleton coordinator
│   ├── EstuaryCharacter         — Per-character instance, EventEmitter pattern
│   ├── EstuaryMicrophone        — Audio capture with chunking
│   ├── EstuaryCredentials       — API key + character config
│   └── EstuaryActionManager     — Dispatches typed client_action events (+ dormant legacy tag parser)
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
