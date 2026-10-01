const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function runtime(fetcher, permission = true, timers = {}) {
  const ctx = vm.createContext({ URL, TextDecoder, AbortController, setTimeout, clearTimeout, ...timers,
    fetch: fetcher, chrome: { permissions: { contains: async () => permission } } });
  for (const file of ['providers.js', 'response-stream.js', 'provider-client.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  return ctx;
}
const providers = [
  { id: 'first', name: 'Local', type: 'local', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local', apiKey: 'local-key', protocol: 'chat' },
  { id: 'second', name: 'Cloud', type: 'openai', baseUrl: 'https://provider.example/custom/v2', model: 'online', apiKey: 'cloud-key', protocol: 'chat' },
];
const settings = { providers, primaryProviderId: 'first', autoFallback: true };
const answer = () => Response.json({ choices: [{ message: { content: '译文' } }] });
test('legacy settings migrate without enabling cloud fallback', () => {
  const ctx = runtime();
  const result = ctx.LingoProviders.normalize({ baseUrl: 'http://localhost:9999/v1', model: 'existing' });
  assert.equal(result.providers[0].model, 'existing');
  assert.equal(result.providers[0].baseUrl, 'http://localhost:9999/v1');
  assert.equal(result.autoFallback, false);
});

test('multiple saved profiles preserve stable IDs, explicit backup and legacy two-slot settings', () => {
  const { LingoProviders: api } = runtime();
  const third = { ...providers[1], id: 'third', model: 'different' };
  const normalized = api.normalize({ providers: [...providers, third], primaryProviderId: 'third', backupProviderId: 'first', requestTimeoutSeconds: 25 });
  assert.equal(normalized.providers.length, 3);
  assert.equal(normalized.primaryProviderId, 'third'); assert.equal(normalized.backupProviderId, 'first');
  assert.equal(normalized.requestTimeoutSeconds, undefined);
  assert.equal(api.normalize({ providers, primaryProviderId: 'second' }).backupProviderId, 'first');
  assert.equal(api.normalize({ providers, backupProviderId: '' }).backupProviderId, '');
  assert.equal(api.normalize({ providers, backupProviderId: 'deleted' }).backupProviderId, '');
  assert.equal(api.normalize({ providers, requestTimeoutSeconds: -1 }).requestTimeoutSeconds, undefined);
});

test('slow online generation has no plugin deadline; actual network failure selects explicit backup', async () => {
  const timers = new Map(); let counter = 0;
  const calls = [], notices = []; let failNetwork;
  const ctx = runtime((url, options) => {
    calls.push({ url, options });
    if (url.includes('primary.example')) return new Promise((_, reject) => { failNetwork = reject; });
    return Promise.resolve(answer());
  }, true, { setTimeout: (fn, ms) => { timers.set(++counter, { fn, ms }); return counter; }, clearTimeout: id => timers.delete(id) });
  const config = { providers: [{ ...providers[1], id: 'first', baseUrl: 'https://primary.example/v1' }, providers[1],
    { ...providers[1], id: 'third', baseUrl: 'https://backup.example/v1', apiKey: 'third-key' }],
    primaryProviderId: 'first', backupProviderId: 'third', autoFallback: true, requestTimeoutSeconds: 5 };
  const pending = ctx.LingoClient.translate(config, 'rules', 'current', undefined, info => notices.push(info));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(timers.size, 0, 'no generation timeout may be scheduled');
  assert.equal(notices.length, 0);
  failNetwork(new Error('network connection reset'));
  const result = await pending;
  assert.equal(result.provider.id, 'third'); assert.equal(result.fallback, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].primaryError, result.primaryError);
  assert.match(result.primaryError, /连接失败/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer third-key');
  assert.equal(timers.size, 0);
});

test('subscription transport failure supports local backup; opt-out never calls backup', async () => {
  for (const autoFallback of [true, false]) {
    const timers = new Map(); let index = 0, localCalls = 0, failNetwork;
    const ctx = runtime(async () => { localCalls++; return answer(); }, true,
      { setTimeout: fn => { timers.set(++index, fn); return index; }, clearTimeout: id => timers.delete(id) });
    ctx.LingoSubscription = { request: (_path, _body, timeout) => {
      assert.equal(timeout, 0);
      return new Promise((_, reject) => { failNetwork = reject; });
    } };
    const pending = ctx.LingoClient.translate({ providers: [{ ...providers[0], type: 'codex' }, { ...providers[0], id: 'second' }],
      primaryProviderId: 'first', backupProviderId: 'second', autoFallback, requestTimeoutSeconds: 5 }, 'rules', 'text');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.size, 0);
    failNetwork(Object.assign(new Error('network timeout'), { offline: true }));
    if (autoFallback) assert.equal((await pending).fallback, true);
    else await assert.rejects(pending, /network timeout/);
    assert.equal(localCalls, autoFallback ? 1 : 0);
  }
});

test('backup failure stops after one switch; unrelated profiles are never tried', async () => {
  let calls = 0;
  const ctx = runtime(async () => { calls++; return new Response('', { status: 503 }); });
  await assert.rejects(ctx.LingoClient.translate({ providers: [{ ...providers[1], id: 'first' }, providers[1], { ...providers[1], id: 'third' }],
    primaryProviderId: 'first', backupProviderId: 'third', autoFallback: true }, 's', 'current'), /备用也失败/);
  assert.equal(calls, 2);
});
test('explicit gateway paths are preserved; root gets v1', () => {
  const ctx = runtime();
  assert.equal(ctx.LingoProviders.url('https://x.example/custom/v2/', 'models'), 'https://x.example/custom/v2/models');
  assert.equal(ctx.LingoProviders.url('https://x.example', 'models'), 'https://x.example/v1/models');
});
test('offline local falls back with only cloud key and current image/prompt', async () => {
  const calls = [];
  const ctx = runtime(async (url, opts) => {
    calls.push([url, opts]);
    if (url.startsWith('http://127')) throw new TypeError('offline');
    return answer();
  });
  const result = await ctx.LingoClient.translate(settings, 'system', 'this input', 'data:image/png;base64,AA==');
  assert.equal(result.fallback, true);
  assert.equal(result.provider.model, 'online');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer cloud-key');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer local-key');
  const body = JSON.parse(calls[1][1].body);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,AA==');
  assert.equal(body.messages[0].content, 'system');
  assert.equal(body.history, undefined);
});
test('unchecked fallback never sends content to cloud', async () => {
  const calls = [];
  const ctx = runtime(async url => { calls.push(url); throw new TypeError('offline'); });
  await assert.rejects(ctx.LingoClient.translate({ ...settings, autoFallback: false }, 's', 'private'));
  assert.equal(calls.length, 1);
  assert.ok(calls.every(url => url.startsWith('http://127')));
});
test('local missing model triggers online fallback, next request retries local first', async () => {
  let count = 0;
  const ctx = runtime(async url => {
    if (url.startsWith('http://127')) { count++; return new Response('', { status: 404 }); }
    return answer();
  });
  await ctx.LingoClient.translate(settings, 's', 'one');
  await ctx.LingoClient.translate(settings, 's', 'two');
  assert.equal(count, 2);
});
for (const status of [400, 401, 403, 404, 429]) {
  test(`HTTP ${status} switches once when explicitly enabled and exposes sanitized primary error`, async () => {
    const calls = [];
    const ctx = runtime(async url => { calls.push(url); return calls.length === 1 ? new Response('do-not-reflect-secret', { status }) : answer(); });
    const result = await ctx.LingoClient.translate(settings, 's', 'private');
    assert.equal(calls.length, 2);
    assert.equal(result.fallback, true);
    assert.match(result.primaryError, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(result.primaryError, /do-not-reflect-secret/);
  });
}
test('second provider can be selected directly; Responses body is stateless', async () => {
  let sent;
  const ctx = runtime(async (url, opts) => {
    sent = { url, ...opts };
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] });
  });
  const result = await ctx.LingoClient.translate({ ...settings, primaryProviderId: 'second', providers: [providers[0], { ...providers[1], protocol: 'responses' }] }, 'rules', 'source');
  assert.equal(result.text, 'Hello');
  assert.equal(result.fallback, false);
  assert.ok(sent.url.endsWith('/responses'));
  const body = JSON.parse(sent.body);
  assert.equal(body.store, false);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.instructions, 'rules');
});

test('streaming chat tolerates reasoning and heartbeats, without a generation timer or partial history', async () => {
  const events = [': heartbeat\n\n', 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"private thought"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"译文"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];
  const ctx = runtime(async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }, true, { setTimeout: () => { throw new Error('must not schedule generation timeout'); } });
  const result = await ctx.LingoClient.translate({ ...settings, autoFallback: false }, 'rules', 'long text');
  assert.equal(result.text, '译文');
});

test('unfinished stream triggers backup, rather than returning half a translation', async () => {
  let calls = 0;
  const ctx = runtime(async () => ++calls === 1
    ? new Response('data: {"choices":[{"index":0,"delta":{"content":"half"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    : answer());
  const result = await ctx.LingoClient.translate(settings, 's', 'source');
  assert.equal(result.text, '译文');
  assert.equal(result.fallback, true);
  assert.match(result.primaryError, /中断/);
});

test('HTTP errors do not invoke backup with switch disabled', async () => {
  for (const status of [400, 401, 403, 404, 413, 429, 500, 504]) {
    let calls = 0;
    const ctx = runtime(async () => { calls++; return new Response('', { status }); });
    await assert.rejects(ctx.LingoClient.translate({ ...settings, autoFallback: false }, 's', 'text'), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
});

test('worker keepalive runs only during pending translation and is released on completion', async () => {
  let resolve, heartbeat, cleared = false, pings = 0;
  const ctx = runtime(() => new Promise(r => { resolve = r; }), true, {
    setInterval: fn => { heartbeat = fn; return 1; }, clearInterval: id => { assert.equal(id, 1); cleared = true; },
    setTimeout: () => { throw new Error('no model deadline'); },
  });
  ctx.chrome.runtime = { getPlatformInfo: async () => { pings++; } };
  const pending = ctx.LingoClient.translate(settings, 's', 'long input');
  await new Promise(r => setImmediate(r));
  heartbeat(); heartbeat();
  assert.equal(pings, 2); assert.equal(cleared, false);
  resolve(answer()); await pending;
  assert.equal(cleared, true);
});
test('missing host permission does not cause cloud fallback', async () => {
  let calls = 0;
  const ctx = runtime(async () => { calls++; return answer(); }, false);
  await assert.rejects(ctx.LingoClient.translate(settings, 's', 'private'));
  assert.equal(calls, 0);
});

test('Codex settings use isolated subscription transport without old bridge or API keys', async () => {
  let nativeCall;
  const ctx = runtime(() => { throw new Error('HTTP must not be called'); }, false);
  ctx.LingoSubscription = { request: async (path, body) => {
    nativeCall = { path, body };
    return { choices: [{ message: { content: 'Subscription translation' } }] };
  } };
  const config = ctx.LingoProviders.normalize({ providers: [{ ...providers[0], type: 'codex', apiKey: 'old-bridge-key' }] });
  assert.equal(config.providers[0].apiKey, '');
  assert.equal(config.providers[0].baseUrl, '');
  const result = await ctx.LingoClient.translate(config, 'prompt', 'only current source');
  assert.equal(result.text, 'Subscription translation');
  assert.equal(nativeCall.path, 'chat/completions');
  assert.equal(nativeCall.body.messages.length, 2);
});
