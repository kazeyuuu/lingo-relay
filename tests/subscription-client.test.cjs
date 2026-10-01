const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const KEY = 'lingoSubscriptionAuth';
const NOW = 1800000000000;
const tick = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
function jwt(account = 'account-1') {
  return `e30.${Buffer.from(JSON.stringify({ exp: NOW / 1000 + 7200, 'https://api.openai.com/auth': {
    chatgpt_account_id: account, chatgpt_plan_type: 'plus',
  } })).toString('base64url')}.signature`;
}
const grant = () => ({ access_token: jwt(), refresh_token: 'refresh-secret', id_token: jwt(), expires_in: 3600 });
const credential = (expiry = NOW + 3600000) => ({ sessionId: 'session-1', accessToken: 'access-old', refreshToken: 'refresh-old', accountId: 'account-1', planType: 'plus', expiresAt: expiry });
function runtime(fetcher, store = {}, permission = true) {
  let time = NOW, listener, secured = false, timerId = 0;
  const calls = [], notifications = [], alarms = new Map(), timers = new Map();
  const chrome = {
    storage: { local: {
      setAccessLevel: async options => { assert.equal(options.accessLevel, 'TRUSTED_CONTEXTS'); secured = true; },
      get: async key => structuredClone({ [key]: store[key] }),
      set: async data => { assert.ok(secured); Object.assign(store, structuredClone(data)); },
    } },
    permissions: { contains: async () => permission },
    runtime: { sendMessage: async message => notifications.push(message), getManifest: () => ({ version: '1.2.0' }) },
    alarms: { create: async (name, details) => alarms.set(name, details), clear: async name => alarms.delete(name), onAlarm: { addListener: fn => listener = fn } },
  };
  class Clock extends Date { static now() { return time; } }
  const ctx = vm.createContext({ chrome, URL, URLSearchParams, TextDecoder, Uint8Array, atob, crypto: webcrypto, Date: Clock,
    AbortController, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options); },
  });
  for (const file of ['response-stream.js', 'subscription-client.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  return { api: ctx.LingoSubscription, ctx, store, calls, notifications, alarms, timers,
    advance: ms => time += ms,
    poll: async () => { listener({ name: 'lingo-subscription-login' }); await tick(); },
  };
}
function sse(text = '译文') {
  const raw = `: ping\r\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\r\n\r\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\r\n\r\n`;
  const bytes = new TextEncoder().encode(raw);
  return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const input = (text = 'current') => ({ model: 'selected-model', messages: [{ role: 'system', content: 'translate only' }, { role: 'user', content: text }] });

test('device grant polls, exchanges PKCE, stores protected tokens and exposes only safe status', async () => {
  let pending = true;
  const rt = runtime(async (url, options) => {
    if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'private-device-id', user_code: 'ABCD-1234', interval: '5' });
    if (url.endsWith('/deviceauth/token')) return pending ? new Response('', { status: 403 }) : Response.json({ authorization_code: 'private-code', code_verifier: 'private-verifier' });
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('code_verifier'), 'private-verifier');
    assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
    return Response.json(grant());
  });
  const login = await rt.api.request('auth/login');
  assert.equal(login.userCode, 'ABCD-1234');
  assert.equal(login.authUrl, 'https://auth.openai.com/codex/device');
  assert.equal(JSON.stringify(login).includes('private-device-id'), false);
  await rt.poll(); assert.equal(rt.calls.length, 1, 'respects polling interval');
  rt.advance(5001); await rt.poll(); assert.equal(rt.calls.length, 2);
  assert.equal((await rt.api.request('auth/status')).loginPending, true);
  pending = false; rt.advance(5001); await rt.poll();
  const status = await rt.api.request('auth/status');
  assert.equal(status.authenticated, true);
  assert.equal(status.planType, 'plus');
  assert.equal(status.loginPending, false);
  assert.equal(status.userCode, '');
  assert.equal(rt.store[KEY].credentials.refreshToken, 'refresh-secret');
  assert.doesNotMatch(JSON.stringify([status, rt.notifications]), /secret|private-|accessToken|refreshToken/);
  assert.equal(rt.alarms.size, 0);
  for (const call of rt.calls) { assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'error'); }
});

test('a resumed worker continues pending login; expired codes are cleaned up', async () => {
  const store = { [KEY]: { flow: { id: 'flow', userCode: 'ABCD', deviceAuthId: 'id', interval: 5000, nextPollAt: NOW, expiresAt: NOW + 10000 } } };
  const rt = runtime(async () => new Response('', { status: 404 }), store);
  await tick(); assert.equal(rt.alarms.size, 1);
  await rt.poll(); assert.equal(rt.calls.length, 1);
  rt.advance(10001); await rt.poll();
  assert.equal((await rt.api.request('auth/status')).loginPending, false);
  assert.match((await rt.api.request('auth/status')).error, /过期/);
  assert.equal(store[KEY].flow, undefined);
});

test('cancel does not erase previous login or allow late device response to revive flow', async () => {
  const delayed = deferred();
  const rt = runtime(() => delayed.promise, { [KEY]: { credentials: credential() } });
  const start = rt.api.request('auth/login');
  await tick();
  await rt.api.request('auth/cancel');
  delayed.resolve(Response.json({ device_auth_id: 'id', user_code: 'ABCD', interval: 5 }));
  await assert.rejects(start, /取消/);
  const status = await rt.api.request('auth/status');
  assert.equal(status.authenticated, true);
  assert.equal(status.loginPending, false);
});

test('logout during token exchange cannot resurrect credentials', async () => {
  const delayed = deferred();
  const rt = runtime(async url => url.endsWith('/oauth/token') ? delayed.promise
    : Response.json({ authorization_code: 'code', code_verifier: 'verifier' }),
  { [KEY]: { flow: { id: 'flow', deviceAuthId: 'id', userCode: 'code', interval: 5000, nextPollAt: NOW, expiresAt: NOW + 900000 } } });
  await rt.poll();
  await rt.api.request('auth/logout');
  delayed.resolve(Response.json(grant()));
  await tick();
  assert.equal((await rt.api.request('auth/status')).authenticated, false);
  assert.equal(rt.store[KEY].credentials, undefined);
});

test('models and stateless image translations call only fixed official endpoints', async () => {
  const rt = runtime(async url => url.includes('/models?')
    ? Response.json({ models: [{ slug: 'visible' }, { slug: 'hidden', visibility: 'hide' }] }) : sse(),
  { [KEY]: { credentials: credential() }, history: ['DO NOT SEND'] });
  assert.equal((await rt.api.request('models')).data[0].id, 'visible');
  const body = input([{ type: 'text', text: 'screenshot prompt' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]);
  const result = await rt.api.request('chat/completions', body);
  assert.equal(result.choices[0].message.content, '译文');
  const call = rt.calls[1];
  assert.equal(call.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(call.options.headers.Authorization, 'Bearer access-old');
  assert.equal(call.options.headers['ChatGPT-Account-Id'], 'account-1');
  const sent = JSON.parse(call.options.body);
  assert.equal(sent.input.length, 1);
  assert.equal(sent.input[0].content[1].type, 'input_image');
  assert.equal(sent.store, false); assert.equal(sent.stream, true);
  assert.equal(sent.instructions, 'translate only');
  assert.equal(sent.previous_response_id, undefined); assert.equal(sent.tools, undefined);
  assert.doesNotMatch(call.options.body, /DO NOT SEND|refresh-old|session-1/);
  await assert.rejects(rt.api.request('chat/completions', { ...body, messages: [...body.messages, body.messages[1]] }), /独立请求/);
});

test('concurrent requests refresh once, persist rotated token and never send it to models', async () => {
  let refreshed = 0;
  const rt = runtime(async (url, options) => {
    if (url.endsWith('/oauth/token')) { refreshed++; assert.equal(JSON.parse(options.body).grant_type, 'refresh_token'); return Response.json(grant()); }
    assert.equal(options.headers.Authorization, `Bearer ${jwt()}`);
    assert.doesNotMatch(JSON.stringify(options), /refresh-secret|refresh-old/);
    return Response.json({ models: [] });
  }, { [KEY]: { credentials: credential(NOW - 1) } });
  await Promise.all([rt.api.request('models'), rt.api.request('models')]);
  assert.equal(refreshed, 1);
  assert.equal(rt.store[KEY].credentials.refreshToken, 'refresh-secret');
});

test('logout during refresh cannot recreate login', async () => {
  const delayed = deferred();
  const rt = runtime(() => delayed.promise, { [KEY]: { credentials: credential(NOW - 1) } });
  const request = rt.api.request('models');
  await tick(); await rt.api.request('auth/logout');
  delayed.resolve(Response.json(grant()));
  await assert.rejects(request, /状态已改变/);
  assert.equal((await rt.api.request('auth/status')).authenticated, false);
});

test('401 refreshes exactly once; quota failures are sanitized and never retried', async () => {
  let models = 0, refresh = 0;
  const rt = runtime(async url => {
    if (url.endsWith('/oauth/token')) { refresh++; return Response.json(grant()); }
    models++; return new Response('secret remote detail', { status: 401 });
  }, { [KEY]: { credentials: credential() } });
  await assert.rejects(rt.api.request('models'), /HTTP 401/);
  assert.equal(models, 2); assert.equal(refresh, 1);
  const quota = runtime(async () => new Response('secret', { status: 429 }), { [KEY]: { credentials: credential() } });
  await assert.rejects(quota.api.request('models'), /额度/);
  assert.equal(quota.calls.length, 1);
});

test('revoked refresh clears local login; no website permission prevents every request', async () => {
  const rt = runtime(async () => new Response('secret', { status: 401 }), { [KEY]: { credentials: credential(NOW - 1) } });
  await assert.rejects(rt.api.request('models'), /授权失效/);
  assert.equal((await rt.api.request('auth/status')).authenticated, false);
  const denied = runtime(() => { throw new Error('must not fetch'); }, {}, false);
  await assert.rejects(denied.api.request('auth/login'), /访问权限/);
  assert.equal(denied.calls.length, 0);
});

test('stream errors and truncation never save partial output as a successful translation', async () => {
  for (const type of ['response.failed', 'response.incomplete', 'error', 'unfinished']) {
    const rt = runtime(async () => new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\ndata: ${JSON.stringify({ type })}\n\n`), { [KEY]: { credentials: credential() } });
    await assert.rejects(rt.api.request('chat/completions', input()), /失败|中断/);
  }
});

test('poll rate limits back off and terminal errors stop polling', async () => {
  let status = 429;
  const rt = runtime(async () => new Response('', { status, headers: { 'Retry-After': '60' } }),
    { [KEY]: { flow: { id: 'flow', deviceAuthId: 'id', userCode: 'code', interval: 5000, nextPollAt: NOW, expiresAt: NOW + 900000 } } });
  await rt.poll(); rt.advance(5001); await rt.poll();
  assert.equal(rt.calls.length, 1);
  status = 400; rt.advance(60000); await rt.poll();
  assert.equal((await rt.api.request('auth/status')).loginPending, false);
  assert.match((await rt.api.request('auth/status')).error, /HTTP 400/);
});

test('extension runtime does not load native messaging or helper code', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.ok(manifest.permissions.includes('alarms'));
  assert.ok(!manifest.permissions.includes('nativeMessaging'));
  const worker = fs.readFileSync(manifest.background.service_worker, 'utf8');
  assert.doesNotMatch(worker, /native-client|connectNative|bridge\//);
  assert.match(worker, /subscription-client\.js/);
});

test('opt-in local fallback integrates with pure subscription for screenshot translation', async () => {
  const rt = runtime(async url => {
    if (url.startsWith('http://localhost')) throw new Error('offline');
    return sse('online translation');
  }, { [KEY]: { credentials: credential() } });
  for (const file of ['providers.js', 'provider-client.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), rt.ctx);
  const providers = [
    { id: 'first', name: 'local', type: 'local', baseUrl: 'http://localhost:1234/v1', model: 'local' },
    { id: 'second', name: 'subscription', type: 'codex', model: 'vision-model' },
  ];
  const config = { providers, autoFallback: true, primaryProviderId: 'first' };
  const result = await rt.ctx.LingoClient.translate(config, 'rules', 'image prompt', 'data:image/png;base64,AA==');
  assert.equal(result.fallback, true);
  assert.equal(result.provider.id, 'second');
  assert.equal(result.text, 'online translation');
  assert.equal(JSON.parse(rt.calls[1].options.body).input[0].content[1].type, 'input_image');
  const before = rt.calls.length;
  await assert.rejects(rt.ctx.LingoClient.translate({ ...config, autoFallback: false }, 'rules', 'private'));
  assert.equal(rt.calls.length, before + 1);
});

test('worker startup detects interrupted one-time exchange rather than replaying it', async () => {
  const rt = runtime(() => { throw new Error('must not replay'); }, { [KEY]: { flow: {
    id: 'flow', exchanging: true, expiresAt: NOW + 900000, nextPollAt: NOW,
  } } });
  await rt.poll();
  assert.equal(rt.calls.length, 0);
  assert.equal((await rt.api.request('auth/status')).loginPending, false);
  assert.match((await rt.api.request('auth/status')).error, /中断/);
});

test('cancelled subscription attempt never starts inference after a delayed token refresh', async () => {
  const delayed = deferred();
  const rt = runtime(() => delayed.promise, { [KEY]: { credentials: credential(NOW - 1) } });
  const controller = new AbortController();
  const pending = rt.api.request('chat/completions', input(), 5000, controller.signal);
  await tick();
  assert.equal(rt.calls.length, 1);
  controller.abort();
  delayed.resolve(Response.json(grant()));
  await assert.rejects(pending, /超时/);
  assert.equal(rt.calls.length, 1, 'no late inference request may start after fallback');
});

test('abort signal reaches subscription response fetch so fallback can stop waiting', async () => {
  const rt = runtime((_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }), { [KEY]: { credentials: credential() } });
  const controller = new AbortController();
  const pending = rt.api.request('chat/completions', input(), 5000, controller.signal);
  await tick(); controller.abort();
  await assert.rejects(pending, error => error.offline === true);
  assert.equal(rt.calls[0].options.signal.aborted, true);
});
