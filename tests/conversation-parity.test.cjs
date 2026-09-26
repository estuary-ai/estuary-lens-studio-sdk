const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./register.cjs');
const { EstuaryManager } = require('../src/Components/EstuaryManager.ts');
const { EstuaryCharacter } = require('../src/Components/EstuaryCharacter.ts');
const { EstuaryClient } = require('../src/Core/EstuaryClient.ts');
const { parseBotVoice } = require('../src/Models/BotVoice.ts');
const { EstuaryPlaybackTracker } = require('../src/Components/EstuaryPlaybackTracker.ts');
const { EstuaryClipPlayer } = require('../src/Components/EstuaryClipPlayer.ts');
const { createLensScheduler } = require('../src/Utilities/LensScheduler.ts');

function setup(t) {
    const manager = EstuaryManager.instance;
    const character = new EstuaryCharacter('agent', 'player');
    character.autoReconnect = false;
    manager.registerCharacter(character);
    manager._client._state = 'connected';
    character.handleSessionConnected({ sessionId: 'session' });
    t.after(() => { character.autoReconnect = false; character.dispose(); manager.dispose(); });
    return { character, manager, client: manager._client };
}

test('contract events reach client, manager and character with wire data preserved', t => {
    const { character, manager, client } = setup(t);
    const fixtures = [
        ['memory_updated', 'memoryUpdated', { agent_id: 'agent', new_memories: [{ id: 'm', memoryType: 'fact', content: 'hello' }] }],
        ['motive_updated', 'motiveUpdated', { agent_id: 'agent', motive: 'private' }],
        ['turn_metrics', 'turnMetrics', { message_id: 'm', status: 'complete', llm_ttft_ms: null }],
        ['delegation_update', 'delegationUpdate', { invocation_id: 'task', status: 'completed', result: { done: true } }],
        ['api_endpoint_result', 'apiEndpointResult', { message_id: 'm', tool_call_id: 'tool', media: [] }],
        ['quota_exceeded', 'quotaExceeded', { message: 'quota', remaining: 0 }],
        ['error', 'serverError', { message: 'wait', error: 'rate_limited' }],
    ];
    for (const [wire, event, data] of fixtures) {
        for (const target of [character, manager, client]) {
            let calls = 0;
            target.on(event, payload => { calls++; assert.deepEqual(payload, data); });
            target._calls = () => calls;
        }
        client.handleServerEvent(wire, data);
        for (const target of [character, manager, client]) assert.equal(target._calls(), 1);
    }
    assert.equal(character._serverEndedSession, false, 'quota and rate limiting are not terminal');
});

for (const [event, data] of [
    ['session_rejected', { reason: 'concurrent_limit', cap: 1 }],
    ['moderation_warning', { level: 'terminated', message: 'ended' }],
]) test(`${event} stops resources and suppresses both reconnect layers`, t => {
    const { character, manager, client } = setup(t);
    let stopped = 0, reconnected = 0;
    character.microphone = { startRecording() {}, stopRecording(flush) { stopped++; assert.equal(flush, false); } };
    character.autoReconnect = true;
    client.autoReconnect = true;
    manager.connect = () => { reconnected++; };
    client.handleReconnect = () => { reconnected++; };
    client.handleServerEvent(event, data);
    client.handleWebSocketClose();
    client.handleWebSocketClose();
    assert.equal(reconnected, 0);
    assert.ok(stopped >= 1);
});

test('warning is nonterminal and malformed optional events are ignored', t => {
    const { character, client } = setup(t);
    let warnings = 0;
    character.on('moderationWarning', () => warnings++);
    client.handleServerEvent('moderation_warning', { level: 'warning', message: 'notice' });
    client.handleServerEvent('moderation_warning', { level: 'other' });
    client.handleServerEvent('memory_updated', null);
    assert.equal(warnings, 1);
    assert.equal(character._serverEndedSession, false);
});

test('PTT waits for STT readiness, flushes final mic audio before stop, and stays sticky', t => {
    const { character, client } = setup(t);
    const events = [];
    client.emitSocketEvent = (event, data) => events.push([event, data]);
    character.microphone = {
        startRecording() { events.push(['mic']); },
        stopRecording(flush) { if (flush !== false) character.streamAudio('YQ=='); },
    };
    character.beginPushToTalk();
    assert.deepEqual(events, [['start_voice', { turn_mode: 'push_to_talk' }]]);
    client.handleServerEvent('voice_started', {});
    character.endPushToTalk();
    assert.deepEqual(events.map(item => item[0]), ['start_voice', 'mic', 'stream_audio', 'stop_voice']);
    assert.throws(() => character.startVoiceSession('continuous'), /Reconnect/);
    character.beginPushToTalk();
    assert.equal(events.at(-1)[0], 'stop_voice', 're-press waits for stream teardown');
    client.handleServerEvent('voice_stopped', {});
    assert.equal(events.at(-1)[1].turn_mode, 'push_to_talk');
});

test('release while STT opens does not start the mic or race stop ahead of readiness', t => {
    const { character, client } = setup(t);
    const events = [];
    client.emitSocketEvent = event => events.push(event);
    character.microphone = { startRecording() { throw new Error('must not record'); }, stopRecording() {} };
    character.beginPushToTalk();
    character.endPushToTalk();
    assert.deepEqual(events, ['start_voice']);
    client.handleServerEvent('voice_started', {});
    assert.deepEqual(events, ['start_voice', 'stop_voice']);
    assert.equal(character.isVoiceSessionActive, false);
});

test('re-press during the initial STT open survives the earlier pending release', t => {
    const { character, client } = setup(t);
    const events = [];
    client.emitSocketEvent = event => events.push(event);
    character.microphone = { startRecording() { events.push('mic'); }, stopRecording() {} };
    character.beginPushToTalk(); character.endPushToTalk(); character.beginPushToTalk();
    client.handleServerEvent('voice_started', {});
    client.handleServerEvent('voice_stopped', {});
    client.handleServerEvent('voice_started', {});
    assert.deepEqual(events, ['start_voice', 'stop_voice', 'start_voice', 'mic']);
    assert.equal(character.isVoiceSessionActive, true);
});

test('voice timeout stops capture while text and textOnly remain available', t => {
    const { character, client } = setup(t);
    const sent = [];
    client.emitSocketEvent = (...args) => sent.push(args);
    character.startVoiceSession();
    client.handleServerEvent('voice_started', {});
    client.handleServerEvent('voice_timeout', {});
    assert.equal(character.isConnected, true);
    assert.equal(character.isVoiceSessionActive, false);
    character.sendText('quiet', true);
    character.sendText('legacy');
    assert.deepEqual(sent.slice(-2), [['text', { text: 'quiet', textOnly: true }], ['text', { text: 'legacy' }]]);
});

test('message IDs isolate partial text and tombstones block late text, audio and actions', t => {
    const { character, client } = setup(t);
    const responses = [], voices = [], actions = [];
    character.on('botResponse', data => responses.push(data));
    character.on('voiceReceived', data => voices.push(data));
    character.on('clientAction', data => actions.push(data));
    client.handleServerEvent('bot_response', { message_id: 'one', text: 'Looking', is_final: true });
    client.handleServerEvent('bot_voice', { message_id: 'two', audio: 'YQ==' });
    client.handleServerEvent('bot_response', { message_id: 'two', text: 'Answer', is_final: false });
    assert.equal(character.currentPartialResponse, 'Answer');
    client.handleServerEvent('interrupt', { message_id: 'one' });
    assert.equal(character.currentPartialResponse, 'Answer');
    client.handleServerEvent('bot_response', { message_id: 'one', text: 'late' });
    client.handleServerEvent('bot_voice', { message_id: 'one', audio: 'YQ==' });
    client.handleServerEvent('client_action', { name: 'wave', message_id: 'one' });
    assert.equal(responses.length, 2);
    assert.equal(voices.length, 1);
    assert.equal(actions.length, 0);
    client.handleServerEvent('moderation_flag', { message_id: 'two', action: 'redacted', message: 'Removed' });
    assert.equal(character.currentPartialResponse, 'Removed');
    client.handleServerEvent('bot_response', { message_id: 'two', text: 'revive' });
    assert.equal(character.currentPartialResponse, 'Removed');
});

test('playback requires final audio and a playout clock, not text final or wall time', t => {
    const { character, client } = setup(t);
    let cursor = 0;
    const sent = [], played = [];
    client.emitSocketEvent = (...args) => sent.push(args);
    const tracker = new EstuaryPlaybackTracker(character, { addAudioFrame: data => played.push(data), interruptAudioOutput() {} }, () => cursor, () => new Uint8Array(48000));
    character.handleBotVoice(parseBotVoice({ message_id: 'one', audio: 'pcm', sample_rate: 24000 }));
    client.handleServerEvent('bot_response', { message_id: 'one', text: 'done', is_final: true });
    cursor = 2;
    tracker.tick();
    assert.equal(sent.length, 0, 'temporary starvation or text final is not completion');
    character.handleBotVoice(parseBotVoice({ message_id: 'one', audio: 'pcm', sample_rate: 24000, is_final: true }));
    cursor = 2.99; tracker.tick(); assert.equal(sent.length, 0);
    cursor = 3; tracker.tick(); tracker.tick();
    assert.deepEqual(sent, [['audio_playback_complete', { message_id: 'one' }]]);
    assert.equal(played.length, 2);
    tracker.dispose();
});

test('interruption and clock reset cancel pending playback completions', t => {
    const { character, client } = setup(t);
    let cursor = 5, stops = 0;
    const sent = [];
    client.emitSocketEvent = (...args) => sent.push(args);
    const tracker = new EstuaryPlaybackTracker(character, { addAudioFrame() {}, interruptAudioOutput() { stops++; } }, () => cursor, () => new Uint8Array(48000));
    const add = id => character.handleBotVoice(parseBotVoice({ message_id: id, audio: 'pcm', is_final: true }));
    add('old'); character.handleInterrupt({ messageId: 'old' });
    add('new'); const prior = stops;
    character.handleInterrupt({ messageId: 'old' });
    assert.equal(stops, prior, 'late interrupt does not stop new speech');
    cursor = 0; tracker.tick(); cursor = 100; tracker.tick();
    assert.deepEqual(sent, []);
    tracker.dispose();
});

test('no playout clock retains server estimate; no fabricated completion', t => {
    const { character, client } = setup(t);
    let plays = 0;
    client.notifyAudioPlaybackComplete = () => assert.fail('No verified drain');
    const tracker = new EstuaryPlaybackTracker(character, { addAudioFrame() { plays++; }, interruptAudioOutput() {} }, undefined, () => new Uint8Array(2));
    character.handleBotVoice(parseBotVoice({ message_id: 'one', audio: 'pcm', is_final: true }));
    tracker.tick(); assert.equal(plays, 1); tracker.dispose();
});

test('redaction flushes older audio still sharing the native buffer with a newer message', t => {
    const { character } = setup(t);
    let stops = 0;
    const tracker = new EstuaryPlaybackTracker(character, {
        addAudioFrame() {}, interruptAudioOutput() { stops++; },
    }, undefined, () => new Uint8Array(2));
    for (const id of ['old', 'new']) character.handleBotVoice(parseBotVoice({ message_id: id, audio: 'pcm' }));
    character.handleConversationEvent('moderationFlag', { message_id: 'old', action: 'redacted', message: 'Removed' });
    assert.equal(stops, 1);
    tracker.dispose();
});

test('result cards ignore late image loads and unsafe schemes and clear on redaction', t => {
    const { bindConversationResults } = require('../Examples/ConversationResults.ts');
    const { character } = setup(t);
    const text = { text: '' }, image = { mainPass: { baseTex: 'original' } }, loads = [];
    const dispose = bindConversationResults(character, text, image,
        { makeResourceFromUrl(url) { return url; } },
        { loadResourceAsImageTexture(url, success) { loads.push({ url, success }); } });
    const result = (id, url) => character.handleConversationEvent('apiEndpointResult', {
        message_id: id, tool_call_id: id, operation: 'Look up', media: [{ type: 'image', url }],
    });
    result('old', 'https://cdn.example/old.png');
    result('new', 'https://cdn.example/new.png');
    loads[0].success('old texture'); assert.equal(image.mainPass.baseTex, 'original');
    loads[1].success('new texture'); assert.equal(image.mainPass.baseTex, 'new texture');
    character.handleConversationEvent('moderationFlag', { message_id: 'new', action: 'redacted', message: 'Removed' });
    loads[1].success('late texture'); assert.equal(image.mainPass.baseTex, 'original');
    assert.equal(text.text, 'Response removed');
    result('new', 'https://cdn.example/resurrected.png');
    result('http', 'http://cdn.example/insecure.png');
    result('credentials', 'https://key@cdn.example/private.png');
    assert.equal(loads.length, 2);
    dispose();
});

test('clip actions resolve exact or unique suffix names and unsubscribe on disposal', t => {
    const { character } = setup(t);
    const played = [];
    const clips = new EstuaryClipPlayer(character, {
        clips: [{ name: 'preset:biped:wave' }, { name: 'a:sit' }, { name: 'b:sit' }],
        playClipAt(name, time) { played.push([name, time]); }, stopClip() {},
    });
    character.handleClientAction({ name: 'wave' });
    assert.deepEqual(played, [['preset:biped:wave', 0]]);
    assert.equal(clips.playAction('sit'), false);
    clips.dispose(); character.handleClientAction({ name: 'wave' });
    assert.equal(played.length, 1);
});

test('legacy Lens scheduler converts milliseconds and removes fired/cancelled events', () => {
    const removed = [], events = [];
    const schedule = createLensScheduler({
        createEvent(name) {
            assert.equal(name, 'DelayedCallbackEvent');
            const event = { enabled: true, bind(fn) { this.fn = fn; }, reset(seconds) { this.seconds = seconds; } };
            events.push(event); return event;
        }, removeEvent(event) { removed.push(event); },
    });
    let calls = 0;
    const cancel = schedule(() => calls++, 1500);
    assert.equal(events[0].seconds, 1.5); events[0].fn(); cancel();
    assert.equal(calls, 1); assert.equal(removed.length, 1);
    schedule(() => calls++, 10)(); assert.equal(events[1].enabled, false);
    events[1].fn(); assert.equal(calls, 1);
});

test('HTTP timer fallback destroys its temporary Lens host on fire and cancel', t => {
    const { scheduleDelay } = require('../src/Utilities/LensScheduler.ts');
    const originalTimeout = global.setTimeout, originalScene = global.scene;
    t.after(() => { global.setTimeout = originalTimeout; global.scene = originalScene; });
    global.setTimeout = undefined;
    const events = [], destroyed = [];
    global.scene = { createSceneObject() {
        const event = { enabled: true, bind(fn) { this.fn = fn; }, reset(seconds) { this.seconds = seconds; } };
        events.push(event);
        return {
            createComponent() { return { createEvent() { return event; }, removeEvent() {} }; },
            destroy() { destroyed.push(event); },
        };
    } };
    let calls = 0;
    const cancel = scheduleDelay(() => calls++, 2000);
    assert.equal(events[0].seconds, 2); events[0].fn(); cancel();
    scheduleDelay(() => calls++, 1000)();
    assert.equal(calls, 1); assert.equal(destroyed.length, 2);
});
