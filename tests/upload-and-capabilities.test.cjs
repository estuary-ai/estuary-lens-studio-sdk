const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./register.cjs');
const path = require('node:path');

const sourceRoot = process.env.ESTUARY_SDK_SOURCE || path.join(__dirname, '../src');
const isDemoCopy = Boolean(process.env.ESTUARY_SDK_SOURCE);
const { setInternetModule, EstuaryClient } = require(path.join(sourceRoot, 'Core/EstuaryClient.ts'));
const { EstuaryHttpClient, ImageUploadFailedError } = require(path.join(sourceRoot, 'Core/EstuaryHttpClient.ts'));

const agent = JSON.stringify({ id: 'agent-1', name: 'Test' });

function setup(responses) {
    const requests = [];
    const delays = [];
    global.RemoteServiceHttpRequest = {
        HttpRequestMethod: { Post: 'POST', Get: 'GET' },
        create() {
            return {
                headers: {},
                setHeader(name, value) { this.headers[name] = value; },
            };
        },
    };
    setInternetModule({
        performHttpRequest(request, callback) {
            requests.push(request);
            const next = responses.shift();
            if (next instanceof Error) throw next;
            if (next === undefined) return; // Simulate a request that never calls back.
            callback({
                statusCode: next.status,
                body: next.body || '',
                getHeader(name) {
                    if (next.throwOnMissingHeader && !Object.hasOwn(next.headers || {}, name)) {
                        throw new Error('HTTP header not found');
                    }
                    return next.headers?.[name] || '';
                },
            });
        },
    });
    const client = new EstuaryHttpClient({ serverUrl: 'http://localhost:4001', apiKey: 'key', playerId: 'player', characterId: 'unused' });
    client.scheduleDelayedCallback = (callback, delay) => {
        if (delay === 35000) return; // In these tests the HTTP callback returns first.
        delays.push(delay);
        callback();
    };
    return { client, requests, delays };
}

test('503 then 201 reuses a UUIDv4 key and retries with bounded jitter', async () => {
    const { client, requests, delays } = setup([{ status: 503, body: 'busy' }, { status: 201, body: agent }]);
    const result = await client.uploadImageToCharacter('aW1hZ2U=', 'image/png');
    assert.equal(result.id, 'agent-1');
    assert.equal(requests.length, 2);
    const key = requests[0].headers['Idempotency-Key'];
    assert.match(key, /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    assert.equal(requests[1].headers['Idempotency-Key'], key);
    assert.equal(requests[0].headers['X-API-Key'], 'key');
    assert.ok(delays[0] >= 750 && delays[0] <= 1250);
});

test('exhaustion carries key, attempts, last status, and a 512-byte response prefix', async () => {
    const { client, requests, delays } = setup(Array(3).fill({ status: 503, body: 'é'.repeat(300) }));
    await assert.rejects(client.uploadImageToCharacter('aW1hZ2U=', 'image/jpeg'), error => {
        assert.ok(error instanceof ImageUploadFailedError);
        assert.equal(error.attempts, 3);
        assert.equal(error.last_status, 503);
        assert.equal(Buffer.byteLength(error.last_response_text), 512);
        assert.ok(requests.every(request => request.headers['Idempotency-Key'] === error.idempotency_key));
        return true;
    });
    assert.equal(delays.length, 2);
    assert.ok(delays[1] >= 1500 && delays[1] <= 2500);
});

test('400 fails without retry', async () => {
    const { client, requests } = setup([{ status: 400, body: 'bad image' }]);
    await assert.rejects(client.uploadImageToCharacter('bad', 'image/png'), /status 400/);
    assert.equal(requests.length, 1);
});

test('an in-flight 409 stops immediately but retains the key for a later resume', async () => {
    const { client, requests } = setup([{ status: 503, body: 'busy' }, { status: 409, body: 'pending' }]);
    await assert.rejects(client.uploadImageToCharacter('aW1hZ2U=', 'image/png'), error => {
        assert.ok(error instanceof ImageUploadFailedError);
        assert.equal(error.attempts, 2);
        assert.equal(error.last_status, 409);
        assert.equal(error.idempotency_key, requests[0].headers['Idempotency-Key']);
        return true;
    });
    assert.equal(requests.length, 2);
});

test('status 0, -1, and callback timeout use the same retry key', async () => {
    const { client, requests } = setup([{ status: 0 }, { status: -1 }, undefined]);
    client.scheduleDelayedCallback = (callback, delay) => {
        if (delay === 35000) queueMicrotask(callback);
        else callback();
    };
    await assert.rejects(client.uploadImageToCharacter('aW1hZ2U=', 'image/png'), error => {
        assert.ok(error instanceof ImageUploadFailedError);
        assert.equal(error.attempts, 3);
        assert.equal(error.last_status, null);
        assert.ok(requests.every(request => request.headers['Idempotency-Key'] === error.idempotency_key));
        return true;
    });
});

test('429 honors Retry-After seconds and HTTP date, capped at 30 seconds', async () => {
    const { client, delays } = setup([
        { status: 429, headers: { 'Retry-After': '2' } },
        { status: 429, headers: { 'Retry-After': new Date(Date.now() + 60_000).toUTCString() } },
        { status: 201, body: agent },
    ]);
    await client.uploadImageToCharacter('aW1hZ2U=', 'image/png');
    assert.deepEqual(delays, [2000, 30000]);
});

test('202 encounter succeeds when Snap throws for an absent Retry-After header', async () => {
    const encounterId = 'encounter-123';
    const { client, requests } = setup([{
        status: 202,
        body: JSON.stringify({ encounterId }),
        throwOnMissingHeader: true,
    }]);
    const result = await client.startEncounter({
        characterAId: 'character-a',
        characterBId: 'character-b',
        prompt: 'Debate lunch',
    });
    assert.deepEqual(result, { encounterId });
    assert.equal(requests.length, 1);
});

test('429 without Retry-After uses bounded retry delay', async () => {
    const { client, delays } = setup([
        { status: 429, throwOnMissingHeader: true },
        { status: 201, body: agent, throwOnMissingHeader: true },
    ]);
    assert.equal((await client.uploadImageToCharacter('aW1hZ2U=', 'image/png')).id, 'agent-1');
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 750 && delays[0] <= 1250);
});

test('transport errors retry and keep the last observed HTTP status', async () => {
    const { client, requests } = setup([{ status: 503, body: 'busy' }, new Error('network down'), new Error('network down')]);
    await assert.rejects(client.uploadImageToCharacter('aW1hZ2U=', 'image/png'), error => {
        assert.ok(error instanceof ImageUploadFailedError);
        assert.equal(error.last_status, 503);
        assert.equal(error.last_response_text, 'busy');
        return true;
    });
    assert.equal(requests.length, 3);
});

test('a resumed call sends the saved key and receives the same character', async () => {
    const { client, requests } = setup([{ status: 201, body: agent }, { status: 201, body: agent }]);
    const key = 'f'.repeat(32);
    const options = { _idempotencyKeyOverride: key };
    assert.equal((await client.uploadImageToCharacter('aW1hZ2U=', 'image/png', options)).id, 'agent-1');
    assert.equal((await client.uploadImageToCharacter('aW1hZ2U=', 'image/png', options)).id, 'agent-1');
    assert.deepEqual(requests.map(request => request.headers['Idempotency-Key']), [key, key]);
});

test('namespace auth carries all Spectacles capabilities on upgrade and direct paths', () => {
    const client = new EstuaryClient();
    client.fetchOpenViaPolling = () => {};
    client.connect('ws://localhost:4001', 'key', 'character', 'player');
    const auth = client._auth;
    const expected = { version: '1', camera: true, microphone: true, speaker: true };
    if (!isDemoCopy) expected.client_action = true;
    assert.deepEqual(auth.capabilities, expected);
    const sent = [];
    client.sendRaw = packet => sent.push(packet);
    client.processSocketIOMessage('3probe');
    client.processSocketIOMessage('0{"sid":"test"}');
    const connects = sent.filter(packet => packet.startsWith('40/sdk,'));
    assert.equal(connects.length, 2);
    for (const packet of connects) {
        assert.deepEqual(JSON.parse(packet.substring('40/sdk,'.length)).capabilities, auth.capabilities);
    }
    client.connectInternal();
    assert.deepEqual(client._auth.capabilities, auth.capabilities);
});

test('rigged generation uses the opt-in and preserves animation metadata', async () => {
    const { client, requests } = setup([{ status: 202, body: JSON.stringify({ modelStatus: 'posing', rigged: true, animations: ['preset:biped:idle'] }) }]);
    const result = await client.generateModel('agent-1', { rigged: true });
    assert.deepEqual(JSON.parse(requests[0].body), { rigged: true });
    assert.equal(result.rigged, true);
    assert.deepEqual(result.animations, ['preset:biped:idle']);
});

test('default model generation stays static', async () => {
    const { client, requests } = setup([{ status: 202, body: JSON.stringify({ modelStatus: 'generating' }) }]);
    await client.generateModel('agent-1');
    assert.deepEqual(JSON.parse(requests[0].body), {});
});

for (const status of ['rig_failed', 'animation_failed']) test(`${status} ends polling with its usable static model`, async () => {
    const { client } = setup([{ status: 200, body: JSON.stringify({ modelStatus: status, modelUrl: 'https://cdn.example/model.glb', rigged: false }) }]);
    const completed = [], errors = [], timers = [];
    client.scheduleDelayedCallback = callback => timers.push(callback);
    client.pollModelStatus('agent', () => {}, value => completed.push(value), value => errors.push(value));
    await timers.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].modelStatus, status);
    assert.equal(errors.length, 0);
    assert.equal(timers.length, 0);
});

test('a replaced model poll ignores the old in-flight response', async () => {
    const { client } = setup([]);
    const timers = [], completed = [];
    let resolveOld;
    client.scheduleDelayedCallback = callback => timers.push(callback);
    client.getModelStatus = () => new Promise(resolve => { resolveOld = resolve; });
    client.pollModelStatus('old', () => {}, value => completed.push(value), assert.fail);
    timers.shift()();
    client.pollModelStatus('new', () => {}, value => completed.push(value), assert.fail);
    resolveOld({ modelStatus: 'completed', progress: 100 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed.length, 0);
    assert.equal(client._pollActive, true);
    client.stopPolling();
});

test('a status callback can cancel polling without receiving completion afterward', async () => {
    const { client } = setup([{ status: 200, body: JSON.stringify({ modelStatus: 'completed', progress: 100 }) }]);
    const timers = [];
    client.scheduleDelayedCallback = callback => timers.push(callback);
    client.pollModelStatus('agent', () => client.stopPolling(), () => assert.fail('cancelled'), assert.fail);
    timers.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client._pollActive, false);
});
