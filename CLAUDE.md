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
session_capabilities: true             # Auth declares camera, microphone, speaker, client_action
livekit_video: false                   # No WebRTC, no LiveKit video
scene_graph: true                      # Feasible; deferred until backend feature is ready
device_pose: true                      # DeviceTracking module
min_audio_sample_rate: 16000           # Recording: hardware-locked to 16kHz
max_audio_sample_rate: 24000           # Playback: 24kHz preferred TTS default
default_playback_sample_rate: 24000    # TTS audio generated at 24kHz
```

## Parity Status

| Feature | Status | Notes |
|---------|--------|-------|
| text_chat | Implemented | `sendText(text, textOnly?)` preserves the server default when omitted. Partial text resets per message ID; interrupted/redacted messages reject late text, audio and actions. |
| say_line | Implemented | Contract currently labels this OPTIONAL. `EstuaryClient.sayLine(text, textOnly?)` emits `say_line` with the `text_only` flag. |
| voice_websocket | Implemented | Base64 PCM over WebSocket (only voice option) |
| voice_push_to_talk | Implemented (device smoke pending) | `beginPushToTalk()` / `endPushToTalk()` send the contract mode, wait for `voice_started` before capture, flush trailing PCM before `stop_voice`, and wait for teardown before re-press. PTT remains sticky until reconnect. |
| voice_livekit | Not available | Spectacles lacks WebRTC — voice_websocket is the only path |
| interrupts | Implemented | `client_interrupt` emitted via `EstuaryCharacter.interrupt()` / `EstuaryManager.sendClientInterrupt()`; inbound `interrupt` parsed with `message_id` / `reason` / `interrupted_at` |
| client_action | Implemented | Typed in-world action calls (SCRUM-202, contract v1.10), fire-on-arrival per contract (not synced to TTS playback). Auth declares `client_action: true`; without it the server uses legacy XML tags. Forwarding: `EstuaryClient` → `EstuaryManager` → `EstuaryCharacter` → `EstuaryActionManager`, which preserves existing action callbacks. The legacy XML parser remains for older lens builds. |
| session_capabilities (SCRUM-142) | Implemented (Preview smoke pending) | Socket.IO namespace auth declares `{version: '1', camera: true, microphone: true, speaker: true, client_action: true}`. One auth object is sent on polling-first upgrade, direct WebSocket fallback, and reconnect. Spectacles does not send cookies on WebSocket; capabilities are in the namespace message body. |
| audio_playback_tracking | Partial (verified-clock opt-in) | `EstuaryPlaybackTracker` integrates DynamicAudioOutput, final audio markers and per-message completion/cancellation. No completion is sent without an app-supplied verified playout clock. The voice example keeps server estimates by default; `AudioComponent.position` needs device validation. A shared native buffer may need a full flush on scoped redaction. |
| vision_camera | Implemented | On-demand via CameraModule |
| video_streaming_livekit | Not available | No WebRTC |
| video_streaming_websocket | Deferred | Deferred by user while the world-model backend is unavailable; on-demand camera capture remains supported. |
| scene_graph | Deferred | Feasible on Spectacles, but explicitly excluded until the backend feature is ready. |
| device_pose | Deferred | Deferred by user with scene graphs and continuous video. The existing contract/handler matrix-shape mismatch remains unresolved; no sender was added. |
| memory_push | Implemented | Typed `memoryUpdated` reaches client, manager and character; retains snake_case envelope and camelCase `new_memories` entries for compatibility. |
| motive_push (v1.7) | Implemented (event only) | Typed `motiveUpdated` reaches client, manager and character. Motives are private owner/director data; do not automatically display them to players. Motive REST and simulation management remain outside the Lens surface. |
| preferences | Deprecated (no-op) | Canonical contract corrected to match the gateway: `enableVisionAcknowledgment` is ignored. No ineffective preference setter was added. |
| quota_exceeded | Implemented | Typed `quotaExceeded` is forwarded on all three layers. An exhausted operation does not automatically terminate the socket. Structured `serverError` is additive to the existing string `error` event. |
| moderation_warning / moderation_flag (v1.24) | Implemented | `terminated` stops capture and suppresses both reconnect layers. `moderationFlag` emits scoped interruption and `responseRedacted`; apps must replace rendered text/media. Late content for the redacted message is discarded. |
| delegation_update (v1.14) | Implemented (event only) | Typed `delegationUpdate` forwarding and an optional progress-card example. Authorization URLs are opaque event data; no authorization flow or auth payload changes were made. |
| api_endpoint_result (v1.26) | Implemented | Typed `apiEndpointResult` forwarding plus `Examples/ConversationResults.ts`: one HTTPS image, bounded citation titles, stale-load suppression and redaction. Preview/device validation pending. |
| http_client | Implemented | Image-to-character (JSON+base64), model polling, character listing |
| rest_canonical_routes (SCRUM-255) | Implemented (untested on device) | Every REST call is on the canonical `/api/v1` surface: `uploadImageToCharacter` = `POST /api/v1/characters/from-image` (JSON + base64; body keys are camelCase `image`, `mimeType`, `appearancePrompt`, `voicePrompt`, `personaPrompt`, and the route rejects unknown keys, so the old snake_case names would 422), `getModelStatus` = `GET /api/v1/characters/{id}/model`, `generateModel` = `POST /api/v1/characters/{id}/model`, `startEncounter` = `POST /api/v1/encounters`, plus the existing `getCharacters` / `getCharacter`. Success is any 2xx, so the new 201 (from-image) and 202 (start-model, encounters) need no handling. from-image now returns the v1 `CharacterResponse`; `parseAgentResponse` already reads both camelCase and snake_case, the same parsing `getCharacter` uses. start-model returns `{characterId, modelStatus, rigged}`, of which `parseModelStatusResponse` keeps `modelStatus`. Node mock tests cover the new upload retry and auth paths; Lens Studio Preview and Spectacles smoke tests remain pending. A key without the needed scope gets `403 {"detail": {"error": "insufficient_scope", "requiredScope": ...}}`, surfaced through the normal thrown `Error` (status + body prefix). |
| client_identification (SCRUM-255) | Implemented (untested on device) | `fetchJson` sends `X-Estuary-Client: estuary-lens-studio-sdk/<ESTUARY_SDK_VERSION>` on every REST request. `ESTUARY_SDK_VERSION` (exported from `src/Core/EstuaryHttpClient.ts`) is the only version constant: there is no package manifest to check it against (`package.native` has zeroed version fields), so **set it by hand to the release tag when tagging**. The legacy `User-Agent: EstuarySDK/1.0` is left as is. Not sent on the WebSocket / Engine.IO polling handshake (Spectacles cannot set WebSocket headers) and not on `downloadAndInstantiateGlb` (`makeResourceFromUrl` cannot carry headers, and GLB hosts are third-party). |
| image_to_character (SCRUM-145) | Implemented (Preview smoke pending) | JSON+base64 (no multipart/form-data on Spectacles), fresh UUIDv4-format `Idempotency-Key` per call, same key for up to three attempts, 1s/2s backoff with ±25% jitter, bounded `Retry-After` on 429, and `ImageUploadFailedError` carrying the key and diagnostics. |
| model_polling | Implemented | Exponential backoff 2s–10s; obsolete in-flight polls and callback-triggered cancellation cannot finish a replacement poll. |
| rigged_model_generation (v1.25) | Implemented (device smoke pending) | `generateModel(id, {rigged: true})`, rigging states and metadata, static fallback on rig/animation failure when `modelUrl` exists. `EstuaryClipPlayer` resolves exact or unique suffix clip names for `client_action`. |
| character_listing | Implemented | Paginated GET /api/v1/characters |
| glb_download | Implemented | downloadAndInstantiateGlb() on EstuaryHttpClient; uses InternetModule + RemoteMediaModule + GltfAsset pipeline |
| session_timeout | Implemented | Server idle-timeout (no conversation activity). Suppression exists at BOTH reconnect layers: `EstuaryClient` flags the close as intentional (`_serverEndedSession`) so its `autoReconnect` stays quiet, AND `EstuaryCharacter` (which does its own reconnection in `handleDisconnected` — the manager disables client-level reconnect by design) skips `_autoReconnect` via its own `_serverEndedSession` flag set in `handleSessionTimeout`. Without the character-layer flag the reap loops: reconnect → re-auth → billed resources → reaped again. Forwarded client → manager → character (`IEstuaryCharacterHandler.handleSessionTimeout?`, optional) and re-emitted as `sessionTimeout` on all three. Character also stops the mic. Resume = explicit `connect()` on user intent (example: `EstuaryVoiceConnection.reconnect()`, wired to tap). |
| voice_timeout | Implemented | Server voice-lane idle release (SDK_CONTRACT.md). No LiveKit on Spectacles, but this ALSO applies to WebSocket voice: after no user speech for `VOICE_IDLE_TIMEOUT_S` (while e.g. text keeps the session alive), the server emits `voice_timeout` and closes the STT stream, KEEPING the socket. `EstuaryClient` re-emits `voiceTimeout` (raw contract payload; deliberately does NOT touch the `_serverEndedSession` reconnect-suppression flag — no disconnect follows, unlike `session_timeout`); `EstuaryManager` forwards to the active character (`IEstuaryCharacterHandler.handleVoiceTimeout?` — optional for backward compat) and re-emits; `EstuaryCharacter.handleVoiceTimeout` stops the mic, clears `_isVoiceSessionActive` (no more audio into the closed stream), and re-emits `voiceTimeout` for the app. No `stop_voice` is sent (server side already released). Resume = `startVoiceSession()` on user intent — recommended UX is the auto-mute illusion. |
| session_rejected | Implemented | `sessionRejected` surfaces the concurrent-session cap and suppresses both reconnect layers. Resume requires explicit application/user intent. |
| encounter | Implemented | `EstuaryManager.startEncounter()` (REST) + `subscribeEncounter()` + `onEncounterMessage` / `onEncounterVoice` / `onEncounterEnd`; voice playback requires consumer to wire two `DynamicAudioOutput` instances (one per speaker) — see SDK_CONTRACT.md §Features > encounter. Inworld characters fall back to default ElevenLabs voice for MVP. NOTE: introduces a new convention — direct `EventEmitter` forwarders on `EstuaryManager` (prior features dispatch through `IEstuaryCharacterHandler`). |
| animation_stream (ARKit-52) | Not implemented | Experimental `bot_animation` facial frames require compatible blendshapes, a local playout clock, auth opt-in and 16 kHz TTS. Lens supports blendshapes, but this integration needs a device performance spike. |
| body_animation_stream | Not implemented | Backend wire is 63-bone MHR LOCAL quats (`bot_pose`, `session_info` body.rig `"mhr63"`, 2026-07-02; SMPL-X 52-bone wire retired). No Spectacles body-rig consumer exists. Incoming frames do not consume the outbound send queue, but their JSON parsing, buffering and rendering need device profiling. Prefer local animation clips for the default experience. |
| bind_pose | Retired | Server event deleted 2026-07-02 (MHR63 rig-native model needs no client bind). Never implemented here — do not add. |
| turn_metrics | Implemented | Typed `turnMetrics` is forwarded on client, manager and character for optional diagnostics; nullable timing fields are preserved. |
| stt_config (`stt_provider` / `stt_language_hints` / `stt_context_terms`, v1.14) | Not applicable | STT is gateway-side: the lens sends 16kHz PCM and gets transcripts back. Engine choice (Deepgram Flux vs Soniox v5), language hints and per-character custom vocabulary are dashboard settings, not client state — nothing to implement, no wire change (SCRUM-232). |
| simulation_v1 | Not implemented | Public Simulation API (SDK_CONTRACT.md §REST API — Simulation (v1), contract v1.4–1.6): worlds/instances REST + `/sim-v1` live streaming + per-instance world-view document + world destroy/memory-clear session isolation (v1.6). Unity is the reference SDK implementation (2026-07-18). Feasible on Spectacles (InternetModule REST + the existing Socket.IO client can join another namespace) but deferred — no Spectacles use case yet; server-to-server orchestration usually owns world/instance management, with the glasses as a viewer at most. |

## Architecture

Implemented scope and usage: [Conversation parity](docs/conversation-parity.md). Protocol regressions and Lens declaration type checks pass; Preview and device acceptance remain pending.

Research and proposed delivery order: [Spectacles parity plan](docs/spectacles-parity-plan.md) (2026-09-26). It separates protocol gaps from platform constraints and records open compatibility checks; it is not evidence of hardware verification.

```
src/
├── Components/              # Lens Studio ScriptComponents (user-facing)
│   ├── EstuaryManager           — Singleton coordinator
│   ├── EstuaryCharacter         — Per-character instance, EventEmitter pattern
│   ├── EstuaryMicrophone        — Audio capture with chunking
│   ├── EstuaryCredentials       — API key + character config
│   ├── EstuaryActionManager     — Dispatches typed client_action events (+ dormant legacy tag parser)
│   ├── EstuaryPlaybackTracker   — Dynamic audio, cancellation, optional verified playout clock
│   └── EstuaryClipPlayer        — Local GLB animation actions
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

### Resilient upload

`EstuaryHttpClient.uploadImageToCharacter()` uses `RemoteServiceHttpRequest` to POST JSON+base64 and sends an `Idempotency-Key` header. The implementation feature-detects [native `crypto.randomUUID()`](https://developers.snap.com/lens-studio/api/lens-scripting/functions/Built-In.crypto.randomUUID) and strips hyphens to retain the existing 32-hex format. Older runtimes use the UUIDv4-format `Math.random()` fallback; this key is a request identifier, not a credential. Retries use the same key for network failures, 429, 502, 503, and 504; other 4xx responses fail immediately. A 429 `Retry-After` value may be seconds or an HTTP date and is capped at 30 seconds. On exhausted transient failures or an in-flight 409, catch `ImageUploadFailedError` and persist its `idempotency_key`; pass it back as `options._idempotencyKeyOverride` with the same image to resume. The request is HTTP, so the WebSocket cookie and send-queue quirks do not apply.

HTTP timers feature-detect native `setTimeout` and otherwise use a temporary scene-owned `DelayedCallbackEvent`, removed on fire/cancel. Apps may inject `createLensScheduler(script)` into `EstuaryHttpClient` instead. Both paths have mocked regression coverage; minimum-runtime/device validation remains pending.

Preview verification: point a test lens at a local gateway or HTTP stub, upload an image, and inspect the request headers. Test a 503 followed by 201, three 503s, a 400, and a 429 with `Retry-After`. Confirm the same key across retries and one character on replay. For SCRUM-142, connect in Preview and confirm gateway logs parse `session_capabilities` without warnings and the camera VLM tool remains available.

Node mock tests: `node --test tests/*.test.cjs` (requires TypeScript; the deployment monorepo reuses `estuary-frontend/node_modules/typescript`). The character-gen demo embeds an older SDK copy: this parity implementation is in the standalone SDK and its examples. Port with an explicit source revision before running the updated suite against that copy; a bulk replacement would also change its auth capabilities and is outside this delivery.

## Code Style

- TypeScript with Lens Studio's module system
- EventEmitter pattern for component communication
- camelCase for methods and properties, PascalCase for classes
- Lens Studio decorator patterns: `@component`, `@input`
