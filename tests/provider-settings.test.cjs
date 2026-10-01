const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function editor(chrome) {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, options: [], listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren(...options) { this.options = options; },
    });
    return elements.get(id);
  } };
  for (const id of ['providerSlot', 'primaryProvider']) {
    document.getElementById(id).options = [{ value: 'first' }, { value: 'second' }];
  }
  const context = vm.createContext({ document, URL, chrome, crypto: require('node:crypto').webcrypto, confirm: () => true,
    Option: function(text, value) { return { text, value }; } });
  for (const file of ['providers.js', 'provider-settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  const change = (id, value) => { const el = document.getElementById(id); el.value = value; el.listeners.change?.(); };
  return { api: context.ProviderEditor, get: document.getElementById, change };
}

test('settings editor preserves both providers and migrates old local settings', () => {
  const { api, get, change } = editor();
  api.initialize({ baseUrl: 'http://localhost:1234/v1', model: 'legacy' });
  assert.equal(get('model').value, 'legacy');
  get('providerName').value = 'Local';
  get('model').value = 'new-local';
  change('providerSlot', 'second');
  get('apiKey').value = 'online-secret';
  get('model').value = 'online-model';
  change('providerSlot', 'first');
  assert.equal(get('model').value, 'new-local');
  assert.equal(get('apiKey').value, '');
  get('primaryProvider').value = 'second';
  const result = api.read();
  assert.equal(result.primaryProviderId, 'second');
  assert.equal(result.autoFallback, false);
  assert.equal(result.providers[1].apiKey, 'online-secret');
  assert.equal(result.providers[1].model, 'online-model');
  api.validate(result);
  result.autoFallback = true;
  assert.throws(() => api.validate(result), /不同的备用方案/);
  result.backupProviderId = 'first';
  assert.doesNotThrow(() => api.validate(result));
});

test('model dropdown retains all eight models even when current ID is already filled', async () => {
  const models = Array.from({ length: 8 }, (_, i) => `model-${i}`);
  const chrome = { permissions: { request: async () => true }, runtime: {
    sendMessage: async () => ({ ok: true, models }),
  } };
  const { api, get, change } = editor(chrome);
  api.initialize({ model: 'model-0' });
  get('refreshModels').listeners.click({ currentTarget: get('refreshModels') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('availableModels').options.length, 9);
  assert.equal(get('availableModels').value, 'model-0');
  change('availableModels', 'model-7');
  assert.equal(get('model').value, 'model-7');
  assert.equal(api.read().providers[0].model, 'model-7');
  change('providerSlot', 'second'); change('providerSlot', 'first');
  assert.equal(get('availableModels').options.length, 9);
  assert.equal(get('availableModels').value, 'model-7');
  get('model').value = 'custom-model'; get('model').listeners.input();
  assert.equal(get('availableModels').value, '');
  assert.equal(get('availableModels').options.length, 9);
  assert.match(fs.readFileSync('options.html', 'utf8'), /<select id="availableModels"/);
});

test('add and save a third profile preserves prompts, routing and other credentials on reload', async () => {
  const store = { settings: { model: 'local', systemPrompt: 'my prompt', primaryProviderId: 'first' }, lingoSubscriptionAuth: { secret: 'untouched' } };
  const chrome = { permissions: { request: async () => true }, storage: { local: {
    get: async () => structuredClone({ settings: store.settings }),
    set: async data => Object.assign(store, structuredClone(data)),
  } } };
  const { api, get, change } = editor(chrome);
  api.initialize(store.settings);
  get('addProvider').listeners.click();
  get('providerName').value = 'Third vision'; get('model').value = 'vision'; get('apiKey').value = 'third-key';
  const newId = get('providerSlot').value;
  assert.equal(get('primaryProvider').options.length, 3);
  change('primaryProvider', newId);
  change('backupProvider', 'first');
  get('autoFallback').checked = true;
  await get('saveProvider').listeners.click();
  assert.equal(store.settings.providers.length, 3);
  assert.equal(store.settings.primaryProviderId, 'first', 'save current does not silently change priority');
  assert.equal(store.settings.systemPrompt, 'my prompt');
  assert.equal(store.lingoSubscriptionAuth.secret, 'untouched');
  assert.equal(store.settings.providers[2].apiKey, 'third-key');
  const all = api.read(); api.validate(all);
  assert.equal(all.primaryProviderId, newId); assert.equal(all.backupProviderId, 'first');
  const reopened = editor(chrome);
  reopened.api.initialize({ ...store.settings, ...all });
  assert.equal(reopened.api.read().providers.length, 3);
  assert.equal(reopened.get('model').value, 'vision');
  reopened.get('deleteProvider').listeners.click();
  const deleted = reopened.api.read();
  assert.equal(deleted.providers.length, 2);
  assert.equal(deleted.primaryProviderId, 'first');
  assert.equal(deleted.backupProviderId, '');
  assert.equal(deleted.autoFallback, false);
});

test('changing provider type does not carry API credentials to another endpoint', () => {
  const { api, get, change } = editor();
  api.initialize({ model: 'local-model' });
  change('providerSlot', 'second');
  get('apiKey').value = 'online-secret';
  get('model').value = 'online-model';
  change('providerType', 'codex');
  assert.equal(get('apiKey').value, '');
  assert.equal(get('model').value, '');
  assert.equal(get('baseUrl').value, '');
  assert.equal(get('baseUrlField').hidden, true);
  assert.equal(get('apiKeyField').hidden, true);
  assert.equal(get('codexAuth').hidden, false);
  change('providerType', 'openai');
  assert.equal(get('apiKey').value, 'online-secret');
  assert.equal(get('model').value, 'online-model');
  assert.equal(get('codexAuth').hidden, true);
});

test('subscription login opens official page and automatically refreshes status and models', async () => {
  let signedIn = false, onNotification, modelRequests = 0;
  const opened = [];
  const chrome = { runtime: { id: 'a'.repeat(32),
    onMessage: { addListener: fn => onNotification = fn },
    sendMessage: async message => {
      if (message.type === 'GET_MODELS') { modelRequests++; return { ok: true, models: ['subscription-model'] }; }
      if (message.action === 'login') return { ok: true, result: { loginPending: true, userCode: 'ABCD-1234', expiresAt: Date.now() + 900000, authUrl: 'https://auth.openai.com/codex/device' } };
      if (message.action === 'logout') signedIn = false;
      return { ok: true, result: { authenticated: signedIn, planType: signedIn ? 'plus' : '' } };
    } }, permissions: { request: async () => true }, tabs: { create: async data => opened.push(data.url) } };
  const { api, get, change } = editor(chrome);
  api.initialize({ model: 'local' });
  change('providerSlot', 'second');
  change('providerType', 'codex');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('authStatus').textContent, '尚未登录');
  get('codexLogin').listeners.click({ currentTarget: get('codexLogin') });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, ['https://auth.openai.com/codex/device']);
  assert.equal(get('codexDevicePanel').hidden, false);
  assert.equal(get('codexDeviceCode').textContent, 'ABCD-1234');
  signedIn = true;
  onNotification({ type: 'LINGO_CODEX_AUTH_CHANGED', success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('authStatus').textContent, '已登录 · plus');
  assert.equal(get('model').value, 'subscription-model');
  assert.equal(modelRequests, 1);
  assert.equal(get('codexLogout').disabled, false);
  assert.equal(get('codexDevicePanel').hidden, true);
  get('codexLogout').listeners.click({ currentTarget: get('codexLogout') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('codexLogout').disabled, true);
});

test('subscription needs only official host permissions; status never requests permission', async () => {
  const requested = [];
  const chrome = { runtime: { id: 'a'.repeat(32),
    sendMessage: async () => ({ ok: false, error: '请授予官方站点访问权限' }) },
    permissions: { request: async request => { requested.push(...request.origins); return true; } } };
  const { api, get, change } = editor(chrome);
  api.initialize({ model: 'local' });
  change('providerSlot', 'second');
  change('providerType', 'codex');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(get('codexLoginHelp').open, true);
  assert.equal(requested.length, 0);
  await api.authorize([{ type: 'codex' }]);
  assert.deepEqual(requested, ['https://auth.openai.com/*', 'https://chatgpt.com/*']);
});
