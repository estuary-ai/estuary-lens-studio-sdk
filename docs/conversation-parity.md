# Conversation parity on Spectacles

Implemented 2026-09-26 against the current gateway and SDK contract. Node protocol tests and type checks against Lens Studio declarations pass. Preview, actual Spectacles playback and live STT acceptance remain pending.

## Voice and text

```typescript
// Configure the character, InternetModule and microphone as in EstuaryVoiceConnection.
character.sendText('Reply silently', true); // optional textOnly; omit for server default

// Connect these to an application's press/release interaction after connected.
character.beginPushToTalk();
character.endPushToTalk();
```

PTT sends `start_voice {turn_mode: 'push_to_talk'}`. Capture starts only after `voice_started`; a release while STT opens is remembered without briefly recording. Release flushes the microphone tail before `stop_voice`. A new press during teardown waits for `voice_stopped`. PTT remains the mode for that session; reconnect before switching to continuous voice. `startVoiceSession()` without an argument resumes the current mode, initially continuous.

`voiceTimeout` stops local capture while keeping text available. Session rejection, session timeout and terminated moderation stop capture and suppress automatic reconnect at both client and character layers. Explicit `character.connect()` resumes on application/user intent. Quota notices and ordinary moderation warnings remain nonterminal.

Partial text is reset on a new text message ID independently of audio arrival. Interrupted/redacted message IDs remain blocked for the session, so late text, voice and actions cannot revive them.

## Typed events

These additive events are available on `EstuaryClient`, `EstuaryManager` and `EstuaryCharacter`. Event payloads preserve the wire casing, including the existing low-level `memoryUpdated` API. Older events such as `botResponse` retain their current camelCase models.

| Event | Payload / use |
| --- | --- |
| `serverError` | Structured `{message, error?}`; existing string `error` also fires |
| `quotaExceeded` | Usage, limit, remaining quota and tier |
| `sessionRejected` | Reason, concurrent-session cap and share-token ID |
| `moderationWarning` | Warning or terminal session status |
| `moderationFlag` | Redacted `message_id`, replacement message and categories |
| `memoryUpdated` | Snake_case envelope, camelCase `new_memories` entries |
| `motiveUpdated` | Private owner/director motive data; not automatically shown to players |
| `delegationUpdate` | Task progress/results; authorization URL is opaque data only |
| `apiEndpointResult` | Operation, `message_id`, `tool_call_id`, images and citations |
| `turnMetrics` | Optional diagnostic timings; preserve nullable values |

```typescript
character.on('quotaExceeded', quota => print(quota.message));
character.on('memoryUpdated', update => print(`${update.new_memories.length} new memories`));
character.on('responseRedacted', flag => {
    // Replace the application-owned transcript entry identified by flag.message_id.
    transcript.replace(flag.message_id, flag.message);
});
```

`responseRedacted` is a character event in addition to the forwarded `moderationFlag`. Its scoped interruption stops affected buffered speech through the playback adapter. Applications own their displayed transcript and must replace its redacted entry.

[ConversationResults.ts](../Examples/ConversationResults.ts) accepts existing Text/Image components, including components in an SIK panel. It shows delegation status, one HTTPS image and at most three citation titles. It ignores late image loads when a newer result arrives, restores the original texture on clear, and discards redacted media. Loads use RemoteMediaModule without Estuary credentials. Dispose the binding when removing the panel. It does not open authorization URLs or implement an auth flow.

## Playback completion and cancellation

```typescript
const playback = new EstuaryPlaybackTracker(character, dynamicAudioOutput);
// Inside the host UpdateEvent:
playback.tick();
```

This default plays PCM with the existing RemoteServiceGateway output helper. It leaves completion timing to the gateway's PCM-duration estimate. It never treats final text or a temporary empty buffer as a completed audio stream.

For an application with a verified native playout clock, pass a third argument returning played seconds:

```typescript
const playback = new EstuaryPlaybackTracker(character, output, readVerifiedPlayoutSeconds);
```

The clock must advance with actual playout, including underruns and pauses, and the output rate must match the negotiated `voice.sampleRate`. Completion requires both `bot_voice.is_final` and the clock reaching the scheduled PCM end. Reports include `message_id` and are sent once. Missing, nonfinite, throwing or backward-moving clocks disable reports until reconnect; normal audio continues using the server estimate. Interrupted messages and disconnected sessions cancel pending reports.

Snap documents [AudioComponent.position](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.AudioComponent.html), but [AudioOutputProvider](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.AudioOutputProvider.html) has no documented queue-drained callback. The voice example's `reportVerifiedPlaybackCompletion` defaults to `false`; enable it programmatically before connecting only after validating the dynamic track on the target hardware/runtime.

The native helper exposes a shared buffer, not selective per-message removal. Redaction/interruption of a message that may remain queued flushes that buffer, potentially discarding already-buffered newer speech too. Without a verified clock, the adapter conservatively retains queued-message membership until a flush. Once an old message is verified drained or was already flushed, its delayed interrupt does not stop newer audio.

The companion gateway change rejects stale completion IDs for `/sdk`. Existing clients that omit IDs retain legacy behavior; TS, Python, Unity and Unreal callers need no new payload shape. Deploy the gateway fix before relying on protection against stale reports from other clients.

## Rigged models and local clips

```typescript
await httpClient.generateModel(characterId, { rigged: true });
httpClient.pollModelStatus(characterId, showProgress, useModel, showError);

// Once the downloaded GLB's AnimationPlayer is available:
const clips = new EstuaryClipPlayer(character, animationPlayer);
// Dispose clips when replacing the model; character disposal also detaches it.
```

The default generation request stays static. Model status preserves `rigged` and `animations`, recognizes posing/rigging/animation progress, and treats `rig_failed` or `animation_failed` with a `modelUrl` as a usable static result. Without a URL, those failures call `onError` and stop polling. Cancelled/replaced polls ignore stale in-flight responses and cancellation from status callbacks.

Clip actions match an exact native clip name or a unique suffix (`wave` → `preset:biped:wave`). Ambiguous suffixes are ignored. Each accepted action stops the previously owned clip and plays the new one from zero through [AnimationPlayer](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.AnimationPlayer.html). Actions fire on arrival; this is not audio-synchronized facial/body streaming.

## Older Lens timers

HTTP retry, timeout and polling scheduling uses native timers when available. Otherwise it creates a temporary script-owned [DelayedCallbackEvent](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.DelayedCallbackEvent) and removes the host when the timer fires or is cancelled. An application can instead supply its existing component:

```typescript
const httpClient = new EstuaryHttpClient(config, createLensScheduler(script));
```

Upload keys prefer feature-detected native `crypto.randomUUID()` and retain the existing 32-hex format. The compatibility fallback remains an idempotency identifier, never an authentication credential.

## Verification and remaining scope

From this SDK directory in the deployment workspace:

```bash
node --test tests/*.test.cjs
../estuary-frontend/node_modules/.bin/tsc --noEmit --skipLibCheck --lib es2021 --target es2021 --module commonjs ../estuary-snap-spectacles-character-gen-demo/Cache/TypeScript/lib/LensifyTS/Declarations/*.d.ts src/index.ts Examples/EstuaryVoiceConnection.ts Examples/ConversationResults.ts
```

The type check requires a Lens-generated declaration cache. The backend regression command is `.venv/bin/python -m pytest tests/test_bot_speaking_audio_end.py -q` from `estuary-backend`.

Device acceptance still needs held speech with a long pause, early release, quick re-press, Deepgram and Soniox sessions, reconnect/timeout handling, buffered redaction, audio underruns, and static/rigged GLB playback. Mock tests establish protocol ordering and cancellation; they do not establish microphone or native playback behavior.

Scene graphs, device pose and continuous video are deferred by user request. Auth paths and capability opt-ins are unchanged. Streamed facial/body animation remains deferred pending rig compatibility and a verified playout clock. The obsolete `enableVisionAcknowledgment` preference was documented as a gateway no-op rather than added as an ineffective setter.

This delivery updates the standalone SDK and its examples. The character-generation demo embeds an older SDK copy with different auth capabilities; it was not bulk-replaced. No demo scene changes are part of this work.
