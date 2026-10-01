const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('public manifest uses current branding and existing shortcuts', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.name, '译流 · LingoRelay');
  assert.equal(manifest.commands['translate-selection'].suggested_key.default, 'Ctrl+Shift+Y');
  assert.equal(manifest.commands['capture-and-translate'].suggested_key.default, 'Ctrl+Shift+U');
  assert.ok(!manifest.permissions.includes('nativeMessaging'));
  for (const file of [manifest.background.service_worker, manifest.options_page, manifest.action.default_popup]) {
    assert.ok(fs.existsSync(path.join(root, file)));
  }
});

test('simplified settings preserve every bound control and use unique IDs', () => {
  const html = read('options.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const source of ['options.js', 'provider-settings.js']) {
    for (const match of read(source).matchAll(/(?:querySelector\("#|\$\(")([a-zA-Z][\w-]*)"/g)) {
      assert.ok(ids.includes(match[1]), `Missing ${match[1]} used by ${source}`);
    }
  }
  assert.doesNotMatch(html, /纯插件设备码登录：|无需安装 Codex、Node.js 或辅助组件/);
});

test('injected content and worker agree on client build', () => {
  const version = file => read(file).match(/const (?:PAGE_)?CLIENT_BUILD = "([^"]+)"/)?.[1];
  assert.ok(version('content.js'));
  assert.equal(version('content.js'), version('service-worker.js'));
});

test('extension pages only load bundled scripts and styles', () => {
  for (const file of ['options.html', 'popup.html']) {
    for (const match of read(file).matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
      assert.doesNotMatch(match[1], /^https?:/);
      assert.ok(fs.existsSync(path.join(root, match[1])), match[1]);
    }
  }
});
