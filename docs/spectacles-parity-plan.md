# Spectacles SDK parity research and delivery plan

Research date: 2026-09-26. Baseline: SDK contract 1.29 and Lens SDK commit `0f7dc5a`. This is a source review and implementation proposal; it does not certify behavior on Spectacles hardware.

## Delivery update (2026-09-26)

Conversation/event handling, PTT, optional playback tracking, local clips, rigged-model handling and timer compatibility are implemented; see [usage and verification](conversation-parity.md). The user explicitly deferred scene graphs, device pose and continuous video and excluded auth-path changes. The later spatial/auth phases below remain research proposals. Playback-clock and other hardware acceptance checks remain pending.

## Recommendation

Target complete conversational behavior on Spectacles: reliable sessions, continuous voice and true push-to-talk, correct audio completion and interruption, camera requests, and accessible typed events for everything a character returns. Add spatial context and local character animations as optional modules. Keep continuous vision and streamed facial/body animation behind explicit opt-ins and device performance gates.

Several missing features are ordinary Socket.IO messages with no platform blocker. Three larger gaps need groundwork: playback completion needs a verified local playout signal; spatial pose needs a consistent backend contract; delegated authorization needs a supported phone handoff for Estuary's existing URL flow.

## What the platform supports

| Area | Evidence from Snap | Implication for Estuary |
| --- | --- | --- |
| Networking | InternetModule supports HTTP, WebSocket and remote assets. WebSocket supports text and binary messages, but lacks `bufferedAmount`, protocol and extensions properties. [Internet access](https://developers.snap.com/spectacles/about-spectacles-features/apis/internet-access), [WebSocket](https://developers.snap.com/spectacles/about-spectacles-features/apis/web-socket). | All small contract events are feasible. Keep the existing Socket.IO/base64 wire format and paced sender. Maintain our own queue metrics; binary support alone does not justify a wire migration. |
| Voice | MicrophoneAudioProvider exposes PCM samples; AudioOutputProvider accepts frames and exposes a preferred frame size. Its documented API does not provide a playback-drained callback. [Microphone](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.MicrophoneAudioProvider.html), [audio output](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.AudioOutputProvider.html). | PTT is feasible now. Automatic completion requires an SDK playback adapter and hardware validation. Keep 16 kHz input and the existing supported playback settings until device measurements justify changes. |
| Camera | CameraModule exposes frame callbacks, configurable frame resolution, still images and camera calibration/pose. Still-image requests require a device; they are not supported in the editor. [Camera Module](https://developers.snap.com/spectacles/about-spectacles-features/apis/camera-module). | On-demand vision belongs in the core experience. Low-rate JPEG streaming is feasible. Use frame callbacks, not the render loop, and share camera ownership between consumers. |
| Spatial context | World Mesh is available on Spectacles. World Query provides lightweight surface hit tests. [World Mesh](https://developers.snap.com/lens-studio/features/ar-tracking/world/world-mesh-and-depth-texture), [World Query](https://developers.snap.com/spectacles/about-spectacles-features/apis/world-query). | The previous claim that scene graphs are inapplicable is incorrect. Estuary scene-graph subscription is itself just a server event stream; it does not require uploading a native world mesh. Pose and surface-aware placement fit glasses well. |
| Rich results | RemoteMediaModule can load remote images, audio and glTF assets through InternetModule. [Remote media](https://developers.snap.com/spectacles/about-spectacles-features/apis/internet-access). | Expose endpoint images/citations and offer a small optional result-card example. The SDK should not impose a full browser UI. |
| Authorization | Auth Kit supports OAuth2 through the Spectacles phone app, requires Lens Studio 5.12.1+, and cannot complete its redirect flow in the editor. WebView is documented as experimental and lacks camera/microphone access. [Auth Kit](https://developers.snap.com/spectacles/spectacles-frameworks/auth-kit/getting-started), [WebView](https://developers.snap.com/spectacles/about-spectacles-features/apis/web-view). | Forward `authorization_required` immediately. Prototype a phone handoff separately. Auth Kit is not proven to accept Estuary's arbitrary `authorization_url`; validate provider configuration and redirect ownership before claiming parity. Do not make experimental WebView a core dependency. |
| Avatars | Lens Studio supports skeletal and blendshape animation. Snap cautions that blendshapes consume power and recommends keeping skeletons under 100 joints. [3D animation](https://developers.snap.com/lens-studio/assets-pipeline/3d/animation/3d-animation), [Spectacles UI guidance](https://developers.snap.com/spectacles/best-practices/design-for-spectacles/ui-design). | Prioritize existing GLB clips triggered by `client_action`. ARKit-52 facial streaming and MHR63 body streaming are feasible research candidates, with asset compatibility, clock synchronization and performance still to prove. |

I found no documented native Spectacles `RTCPeerConnection`/LiveKit integration in the official API sources reviewed. Keep native LiveKit voice/video outside the supported baseline until such a path can be demonstrated. Browser Lens/WebXR is a separate application target and does not establish support inside this Lens SDK.

Publication also affects the baseline: Snap's Transparent Permission supports combining internet access with sensitive sensors using an explicit permission prompt. Experimental APIs remain ineligible for publication. Ship and test the camera/mic experience with that permission flow, including denial, rather than relying on development-only permissions. [Transparent Permission](https://developers.snap.com/spectacles/permission-privacy/transparent-permission).

## Parity decisions

Priorities below are product recommendations. Contract OPTIONAL features remain optional at the protocol level even where they are important for our glasses experience.

| Feature | Verified state | Recommended target |
| --- | --- | --- |
| Session rejection, termination, quota and errors | `session_rejected` and moderation events are unhandled; quota only logs. Timeout suppression already exists at client and character layers. | **P0:** typed events through all public layers; terminal reasons suppress both reconnect paths and release local resources. Preserve voice-only timeout semantics. Surface rate limiting without an automatic resend loop. |
| Push-to-talk | `startVoiceMode()` sends `start_voice: null`, omitting the contract's PTT declaration. | **P0:** explicit voice mode and press/release API. Send `turn_mode: "push_to_talk"`; flush captured audio before `stop_voice`. A held pause must not trigger a bot turn. |
| Audio completion / interrupts | Completion method sends `null`; no component/example calls it. The bundled RSG DynamicAudioOutput loops an AudioComponent and exposes no drain event. | **P0:** one playback owner tracks message IDs, final audio and local playout; emits completion only after playback; cancels obsolete completion on interrupt/disconnect. |
| Text modes and message boundaries | `sendText()` exposes no `textOnly`; character partial-response state is not cleared when a new message ID arrives. | **P0:** add optional text-only mode without changing existing defaults; scope accumulation and playback to message ID, including endpoint acknowledgments followed by a separate answer. |
| Output moderation | `moderation_flag` is ignored. | **P1:** stop and discard the flagged message's buffered audio, replace its displayed text, and prevent late chunks from reviving it. Reuse interruption machinery. |
| Memory, motive and turn metrics | Memory reaches only the low-level client; motive and metrics are absent. | **P1:** typed forwarding through client, manager and character. Motive is private application/director data; no automatic player-facing rendering. Metrics remain opt-in diagnostics. |
| Delegation and endpoint results | Both events fall through the unknown-event logger. | **P1:** typed progress/result events and a minimal status/image/citation example. Treat `delegation_update` as the authoritative result. Expose a callback for app-owned authorization; ship phone completion only after validating the handoff. |
| Rigged model generation | Model generation sends `{}`; response types omit rigging/animation metadata; status helpers know only the older states. | **P1/P2:** optional `rigged` request, complete progress/failure parsing and local clip playback through existing actions. Test a generated asset on hardware; preserve static generation by default. |
| Scene graph / room identification | No subscription or event surface; incorrectly labeled inapplicable. | **P2:** thin subscribe/unsubscribe and typed update APIs, usable independently of local capture. Make unavailable backend world-model service distinguishable from an empty graph. |
| Device pose | No sender. Contract says position/rotation/timestamp; gateway consumes a 4×4 `pose` plus session ID. | **P2 after contract reconciliation:** transform conversion, units/order/clock documentation, tracking-loss behavior and bounded updates. |
| WebSocket video | Missing; hardware camera/network primitives exist. | **P2 opt-in:** low-rate, bounded JPEG capture for world awareness, with automatic backoff under voice load. Establish backend world-model readiness and subscription lifecycle. |
| Preferences | Contract requires `enableVisionAcknowledgment`; gateway explicitly says it was removed and ignores preferences. | **Contract correction:** retire/document the obsolete field consistently across SDKs; do not add a method that promises an effect the backend no longer provides. |
| Facial / body animation streams | Neither ARKit-52 `bot_animation` nor MHR63 `bot_pose` is consumed. | **P3 experiments:** facial animation after the playback clock exists; full-body streaming only for a demonstrated character experience. Keep both opt-in. |
| LiveKit, simulation administration, broad management REST | LiveKit has no demonstrated native path; simulation has no current Lens surface. | **Defer:** keep world administration/serverless orchestration on the backend. A future simulation viewer can be separate. Batch/knowledge wrappers are deliberately excluded by contract, not parity defects. |

SCRUM-142 and SCRUM-145 are implemented with mock coverage, but their Preview/hardware acceptance is still pending. The SDK's canonical REST paths and client-identification header also need device smoke coverage. The character-generation demo contains an older copied SDK with only the targeted ticket fixes; it is not equivalent to the main SDK branch.

## Delivery sequence

### 0. Establish a trustworthy baseline

Record the exact Lens Studio, Snap OS and RemoteServiceGateway package versions used for a supported release. Compile against their actual Lens declarations. Run SCRUM-142/145 and canonical REST smoke scenarios in Preview and on device.

Resolve these findings before marking the release compatible:

- The recent HTTP retry/polling implementation requires native `setTimeout`; Snap documents it from Lens Scripting Version 364, while this repo advertises Lens Studio 5.9+. The checked-in demo declarations contain no `setTimeout` declaration. That is a compatibility risk, not proof of runtime absence. Verify the minimum version or inject a scheduler backed by a component-created `DelayedCallbackEvent` on older supported runtimes. [setTimeout](https://developers.snap.com/lens-studio/api/lens-scripting/functions/Built-In.setTimeout.html), [DelayedCallbackEvent](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.DelayedCallbackEvent).
- Current Snap Lens scripting documentation includes `crypto.randomUUID()`, and the demo declarations include it too. The SDK currently uses Math.random to construct a UUID-format idempotency key. Correct the blanket claim that native UUIDs are unavailable; prefer the native function where verified, with an explicitly scoped compatibility fallback. [Lens runtime randomUUID](https://developers.snap.com/lens-studio/api/lens-scripting/functions/Built-In.crypto.randomUUID).
- SDK docs say a 100 ms send gap; code uses 75 ms and 100 ms microphone chunks. Preserve the tested pacing behavior while reconciling the documentation. Do not change the gap based on documentation alone.
- Snap's sample recommends reading back the microphone's actual sample rate. That supports testing the existing 16 kHz assumption on each supported device/runtime; it does not justify silently changing our hardware workaround. [Snap media examples](https://developers.snap.com/spectacles/about-spectacles-features/snap-cloud/examples/media).

Resolve `device_pose` and obsolete preferences in the canonical contract before their implementation work. Review impacts on every SDK's capability/parity table. Preserve compatible gateway input forms if correcting the pose schema would affect existing consumers.

### 1. Close core conversation gaps

Implement small, reviewable changes in this order:

1. Typed lifecycle/quota/error events and a shared terminal-session policy. Apply it to both reconnect layers. Quota can block an operation without disconnecting, so do not treat every quota event as a dead session.
2. True PTT plus `textOnly` propagation. Reuse the mode semantics already implemented in Python and Unity. PTT is sticky for a session per contract; switching back to continuous mode requires an explicit supported session transition.
3. Playback adapter with per-message state, cancellation and completion. Reuse Estuary's PCM conversion and interruption path; own the integration around the Snap provider rather than modifying cached package files.
4. Message-boundary handling and output redaction, building on that same message state.

**Playback spike first:** the public AudioOutputProvider API and bundled helper do not establish exact native drain timing. Evaluate a supported completion signal or a bounded, SDK-owned sample queue fed at the provider's preferred frame size, with a measured native tail. Temporary starvation between incoming chunks must not count as completion. If exact completion cannot be established, retain the server estimate and document that limitation; do not send an early completion merely because the JavaScript queue emptied or text finished.

Also harden the gateway's completion handler: it currently passes only session state to the response router and logs `message_id` afterward. A stale completion must not end a newer speaking turn. Preserve compatibility for older clients without IDs, and test overlapping turns. This is a small cross-SDK correctness dependency, not a new transport.

**Acceptance:** held speech with a long pause produces no answer until release; release produces one turn; trailing audio is retained; interrupts discard late chunks; a delayed old completion cannot end a new utterance; terminal rejection produces no reconnect loop; voice timeout keeps text usable. Test both configured STT providers, not just Deepgram. Add protocol fixtures plus actual-device audio tests.

### 2. Expose richer character behavior

Add event models and forwarders for memory, motive, metrics, delegation and endpoint results through `EstuaryClient → EstuaryManager → EstuaryCharacter`. Preserve unknown optional fields where useful and tolerate older servers omitting events.

Provide an optional SIK example with a compact task-status indicator and one bounded result card. Correlate results by `message_id` and `tool_call_id`/`invocation_id`. Load HTTPS media without Estuary credentials, limit active textures and release them. Authorization should begin on explicit user action through an application callback; evaluate the Auth Kit phone path against Estuary's actual delegation URL before implementing it.

Extend model-generation options and status parsing, then connect downloaded GLB animation clips to `client_action`. This reuses the existing contract and makes generated characters more expressive without a continuous animation stream.

**Acceptance:** all events reach a high-level caller once; two assistant message IDs stay separate; absent/malformed optional media degrades cleanly; an authorization-needed task remains visibly pending; rigging terminal failures stop polling; existing static model flows still work.

### 3. Add spatial context under a measured budget

Implement scene-graph subscriptions first, then pose and low-rate camera streaming as a coordinated optional module. The gateway currently creates a WebSocket world-model session on its first video frame; pose alone does not create one. Subscription-before-session creation and unavailable-service behavior require integration tests and possibly backend lifecycle fixes.

Define camera-to-world versus world-to-camera transforms, matrix storage order, units, coordinate handedness, capture timestamps and tracking resets. Snap assets commonly use centimeters; do not pass their transforms straight into a backend expecting meters. Calibrate with known translations and rotations. [Snap GLB unit guidance](https://developers.snap.com/spectacles/about-spectacles-features/snap-cloud/examples/basic-setup).

Use this starting experiment, not a claimed platform limit:

- On-demand vision stays the default. For continuous context, begin around **0.5–1 JPEG frame/sec**, with a small configurable image and bounded encoded size.
- Coalesce stale unsent video/pose updates. If pose is sent with a video frame, document the gateway's existing optional `pose` field in the contract first.
- Preserve audio/control ordering, including `start_voice → audio → stop_voice`. Give heartbeat/interruption appropriate priority without reordering the final PTT audio behind its stop signal.
- Keep camera encodes and uploads to one in flight. Stop background capture when disabled, disconnected or permissions are unavailable.
- Measure queue age, dropped/coalesced frames, audio underruns, first-audio latency, memory, CPU/GPU and FPS. Compare with the same Lens running voice alone.

The current microphone produces roughly 10 outbound messages/sec. A 75 ms minimum send gap allows at most about 13.3 sends/sec before frame scheduling overhead, so there is little space for independent high-rate pose and video. This is an Estuary sender constraint, not a universal Spectacles bandwidth limit. Incoming facial/body frames do not consume this outbound queue, but do consume network, JSON-processing, memory and rendering budgets.

Do not upload the raw World Mesh. Snap warns that it can contain millions of indices and be expensive to process in JavaScript. Prefer bounded semantic results from Estuary, camera/pose observations and local World Query hit tests. [World Mesh FAQ](https://developers.snap.com/spectacles/support/spectacles-faq/assets).

**Acceptance:** pose agrees with a known physical motion; stale frames cannot build an unbounded backlog; voice remains usable while vision is on; tracking loss does not inject a false pose; subscribe/reconnect/unsubscribe works against a real world-model backend. Use Spectacles Monitor or the performance overlay and test sustained operation, not just a short Preview run. Snap's guidance targets approximately 60 FPS within the device power budget. [Performance overlay](https://developers.snap.com/spectacles/best-practices/profiling/lens-performance-overlay).

### 4. Gate streamed animation on results

Prototype facial animation on one known compatible avatar after local playout timing is available. The current contract requires `enable_animation: true`, server A2F support and **16 kHz TTS output**. Buffer by `message_id`, render against the local audio clock, skip terminators and clear on interruption. Do not assume arbitrary generated GLBs carry ARKit-52 blendshapes.

Evaluate MHR63 body streaming separately with an explicitly compatible rig and measured frame cost. Prefer local clips for the default character experience. No native LiveKit port or full simulation management layer belongs in these deliveries without a concrete Lens use case and a verified implementation path.

## Prevent parity from drifting again

- Track each feature as implemented, partial, deferred, unavailable or contract mismatch, plus its verification level (mock, Preview, device).
- Keep a contract-event fixture set that exercises the public character/manager surface, not only low-level parsing. Include terminal reconnect, PTT, message IDs and playback cancellation.
- Distribute a versioned SDK package or a repeatable copy/sync process with a recorded source commit. Validate both demos against it; avoid continued manual divergence in embedded SDK copies.
- Keep platform differences in camera/audio/clock/transport adapters. Reuse TypeScript/Python/Unity event and mode behavior where appropriate, while preserving Spectacles' device-tested send pacing and microphone workarounds.

## Local evidence and reuse points

- [Canonical contract](../../SDK_CONTRACT.md): PTT, audio tracking, scene graph, pose, animation and deliberate management exclusions.
- [Lens client](../src/Core/EstuaryClient.ts): event dispatch, PTT payload, completion payload, text payload, paced sender.
- [Lens character](../src/Components/EstuaryCharacter.ts) and [manager](../src/Components/EstuaryManager.ts): reconnect policy, public event forwarding and per-message state.
- [Voice example](../Examples/EstuaryVoiceConnection.ts): bundled audio-helper usage and interruption integration.
- [HTTP client](../src/Core/EstuaryHttpClient.ts) and [model status types](../src/Models/ModelStatusResponse.ts): scheduler, UUID generation, static model request and old status helpers.
- [Gateway SDK handlers](../../estuary-backend/gateway/websocket/sdk_handlers.py): actual PTT declaration, completion handling, preferences no-op and world-model lifecycle.
- [WebSocket video source](../../estuary-backend/gateway/services/world_model/video_input/websocket_source.py): matrix parsing and optional frame pose.
- [Python WebSocket voice](../../estuary-python-sdk/src/estuary_sdk/voice/websocket_voice.py): PTT mode payload and start lifecycle.
- [Unity world-model client](../../estuary-unity-sdk/Runtime/Components/EstuaryWebcam.cs): scene subscriptions and matrix pose sender; still verify coordinate semantics rather than copying blindly.
- [TypeScript playback](../../estuary-ts-sdk/src/audio/audio-player.ts): per-message playback events and interruption behavior; browser audio APIs themselves are not portable to Lens.
