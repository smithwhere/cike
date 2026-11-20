'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ProfileStore } = require('../src/store');
const { ProxyStore } = require('../src/proxystore');
const { BrowserManager } = require('../src/browser');
const { buildBackend, startBackend } = require('../src/server');
const { Settings } = require('../src/settings');
const { SocksForwarder } = require('../src/socksfwd');
const { readProxyNetwork } = require('../src/proxycheck');
const { chromiumBrowsingSwitches } = require('../src/chromium-browsing');
const { HOST_PLATFORM } = require('../src/fingerprint');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cike-security-'));
const provider = { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() }; // codec fixture, not production encryption

test('a backend holds the data-directory lock until shutdown', async () => {
  const dir = temp();
  let backend;
  try {
    backend = await startBackend(dir);
    const first = backend.store.create({ name: 'first writer' });
    await assert.rejects(startBackend(dir), { code: 'ELOCKED' });
    await backend.closeBackend();
    backend = await startBackend(dir);
    assert.equal(backend.store.get(first.id).name, 'first writer');
    assert.equal(backend.store.create({ name: 'second writer' }).sequence, first.sequence + 1);
  } finally {
    await backend?.closeBackend();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy migration is explicit, credentials stay private, corrupt data fails closed', async () => {
  const dir = temp();
  try {
    const store = new ProfileStore(dir);
    const old = store.create({ name: 'old', proxy: { server: 'http://127.0.0.1:1234', password: 'test-secret' } });
    const records = JSON.parse(fs.readFileSync(store.file));
    delete records[old.id].fingerprintMode;
    Object.assign(records[old.id], { platform: 'win', hardwareConcurrency: 4, deviceMemory: 8, canvasNoise: true, webrtc: 'disabled' });
    fs.writeFileSync(store.file, JSON.stringify(records));
    fs.mkdirSync(store.profileDir(old.id));
    fs.writeFileSync(path.join(store.profileDir(old.id), 'session-fixture'), 'preserved');
    fs.chmodSync(store.file, 0o644); fs.chmodSync(dir, 0o755);
    const loaded = new ProfileStore(dir, provider);
    assert.equal(loaded.get(old.id).fingerprintMode, 'legacy');
    await assert.rejects(new BrowserManager(loaded).open(old.id), /转换/);
    // Windows chmod does not implement POSIX permission bits; Windows uses
    // the user's profile ACLs and desktop credentials use safeStorage/DPAPI.
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    }
    assert.ok(!fs.readFileSync(store.file, 'utf8').includes('test-secret'));
    assert.equal(loaded.get(old.id).proxy.password, 'test-secret');
    assert.equal(loaded.public(loaded.get(old.id)).proxy.password, undefined);
    assert.throws(() => new ProfileStore(dir), /桌面版/);
    const migrated = loaded.update(old.id, { fingerprintMode: 'native' });
    assert.equal(migrated.platform, HOST_PLATFORM);
    assert.equal(migrated.previousFingerprint.platform, 'win');
    assert.equal(migrated.hardwareConcurrency, null);
    assert.equal(migrated.webrtc, 'restricted');
    assert.equal(fs.readFileSync(path.join(store.profileDir(old.id), 'session-fixture'), 'utf8'), 'preserved');
    assert.throws(() => loaded.create({ hardwareConcurrency: 4 }), /原生一致/);
    assert.throws(() => loaded.create({ proxy: { server: 'http://user:pass@localhost:80' } }), /认证/);
    assert.throws(() => loaded.profileDir('../escape'), /ID/);
    fs.writeFileSync(store.file, '{broken');
    assert.throws(() => new ProfileStore(dir), /恢复备份/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing, failed, stale and unknown-region proxies cannot launch or fall back', async () => {
  const dir = temp();
  let manager;
  try {
    const store = new ProfileStore(dir), proxies = new ProxyStore(dir, provider);
    const x = proxies.add({ type: 'http', host: '127.0.0.1', port: 9, password: 'test-secret' });
    const p = store.create({ proxyId: x.id });
    assert.ok(!fs.readFileSync(proxies.file, 'utf8').includes('test-secret'));
    let check = async () => ({ status: 'failed', error: 'fixture authentication rejected' });
    manager = new BrowserManager(store, proxies, null, { checkProxy: (...args) => check(...args) });
    await assert.rejects(manager.open(p.id), /authentication/);
    check = async () => ({ status: 'ok', exitIp: '192.0.2.1', countryCode: null, timezone: null });
    await assert.rejects(manager.open(p.id), { proxyCode: 'PROXY_REGION', message: /出口 IP 已验证.*地区未知.*时区未知/ });
    store.update(p.id, { timezone: 'UTC' });
    await assert.rejects(manager.open(p.id), { proxyCode: 'PROXY_REGION', message: /地区未知/ });
    check = async () => { proxies.update(x.id, { port: 10 }); return { status: 'ok' }; };
    await assert.rejects(manager.open(p.id), /发生变化/);
    proxies.remove(x.id);
    await assert.rejects(manager.open(p.id), /阻止直连/);
    assert.equal(manager.sessions.size, 0);
  } finally { await manager?.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('changing the system-proxy policy during a SOCKS check aborts launch before connecting', async t => {
  const dir = temp(), ready = Promise.withResolvers(), probe = Promise.withResolvers();
  let lookups = 0;
  const settings = new Settings(dir, async () => {
    lookups++;
    return 'PROXY 127.0.0.1:8123';
  });
  const store = new ProfileStore(dir);
  const profile = store.create({ proxy: { server: 'socks5://proxy.example:1080' }, locale: 'en-US', timezone: 'UTC' });
  settings.set({ socksViaSystemProxy: true });
  const stop = t.mock.fn(async () => {});
  const forwarder = { port: 9123, stop };
  const forwarding = t.mock.method(SocksForwarder, 'start', async () => forwarder);
  const manager = new BrowserManager(store, null, settings, { checkProxy: (proxy, _settings, route, transport) => {
    ready.resolve({ proxy, route, transport });
    return probe.promise;
  } });
  try {
    const rejected = assert.rejects(manager.open(profile.id), { status: 409, message: /系统代理设置.*变化/ });
    const { proxy, route, transport } = await ready.promise;
    assert.equal(proxy.host, 'proxy.example');
    assert.equal(transport.forwarder, forwarder);
    assert.deepEqual(transport.proxy, { type: 'http', host: '127.0.0.1', port: 9123 });
    assert.deepEqual(route.systemProxy, { scheme: 'http', host: '127.0.0.1', port: 8123 });
    settings.set({ socksViaSystemProxy: false });
    settings.set({ socksViaSystemProxy: true });
    probe.resolve({ status: 'ok', exitIp: '192.0.2.1' });
    await rejected;
    assert.equal(lookups, 1);
    assert.equal(forwarding.mock.callCount(), 1);
    assert.equal(stop.mock.callCount(), 1);
  } finally { probe.resolve({ status: 'failed' }); await manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('independent proxy checks keep the newest result across in-flight checks and saved settings', async () => {
  const dir = temp();
  const started = Array.from({ length: 3 }, () => Promise.withResolvers());
  const probes = started.map(() => Promise.withResolvers());
  let count = 0;
  const backend = buildBackend(dir, { checkProxy: () => {
    const index = count++;
    started[index].resolve();
    return probes[index].promise;
  } });
  const server = backend.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const profile = backend.store.create({ proxy: { server: 'socks5://proxy.example:1080' } });
  const url = `http://127.0.0.1:${server.address().port}/api/profiles/${profile.id}/checkProxy`;
  const request = () => fetch(url, { method: 'POST', headers: { 'x-api-token': backend.token } });
  try {
    const first = request(); await started[0].promise;
    const second = request(); await started[1].promise;
    probes[1].resolve({ status: 'ok', exitIPv6: '2001:0db8::2' });
    assert.equal((await second).status, 200);
    probes[0].resolve({ status: 'ok', exitIp: '192.0.2.1' });
    assert.equal((await first).status, 409);
    assert.equal(backend.store.get(profile.id).lastNetwork.exitIp, '2001:db8::2');
    const obsolete = request(); await started[2].promise;
    backend.store.update(profile.id, { proxy: { server: 'socks5://proxy.example:1081' } });
    probes[2].resolve({ status: 'ok', exitIp: '192.0.2.3' });
    assert.equal((await obsolete).status, 409);
    assert.equal(backend.store.get(profile.id).lastNetwork, null);
  } finally {
    for (const probe of probes) probe.resolve({ status: 'failed' });
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proxy preflight accepts IPv6-only routes and canonicalizes matching exit addresses', async () => {
  const transport = { type: 'http', host: '127.0.0.1', port: 1080 };
  const seen = [];
  const network = await readProxyNetwork(transport, async (proxy, url) => {
    assert.equal(proxy, transport);
    const hostname = new URL(url).hostname;
    seen.push(hostname);
    if (hostname === 'api.ipify.org') throw new Error('IPv4 not available');
    if (hostname === 'api6.ipify.org') return '2001:0DB8:0:0:0:0:0:5';
    return JSON.stringify({ ip: '2001:db8::5', country: 'Fixture', country_code: 'US', timezone: { id: 'Etc/UTC' } });
  });
  assert.deepEqual(seen, ['api.ipify.org', 'api6.ipify.org', 'ipwho.is']);
  assert.deepEqual(network, { exitIp: '2001:db8::5', exitIPv4: null, exitIPv6: '2001:db8::5', country: 'Fixture', countryCode: 'US', timezone: 'Etc/UTC' });
  const regionUnavailable = await readProxyNetwork(transport, async (_proxy, url) => {
    if (url === 'https://api.ipify.org') return '192.0.2.5';
    throw new Error('fixture unavailable');
  });
  assert.deepEqual(regionUnavailable, { exitIp: '192.0.2.5', exitIPv4: '192.0.2.5', exitIPv6: null, country: null, countryCode: null, timezone: null });
  await assert.rejects(readProxyNetwork(transport, async () => 'not an IP'), /响应无效/);
});

test('Chromium restores its browsing protections while retaining other Playwright controls', async () => {
  const chromium = require('playwright').chromium;
  const defaults = await chromium._connection.toImpl(chromium).defaultArgs({ chromiumSandbox: true }, true, '.');
  const { ignoreDefaultArgs, args } = await chromiumBrowsingSwitches(chromium);
  const actual = [...defaults.filter(arg => !ignoreDefaultArgs.includes(arg)), ...args];
  for (const arg of ['--disable-background-networking', '--disable-client-side-phishing-detection', '--disable-component-update', '--no-sandbox']) {
    assert.ok(!actual.includes(arg), arg);
  }
  assert.ok(actual.includes('--remote-debugging-pipe'));
  const features = actual.find(arg => arg.startsWith('--disable-features='));
  assert.match(features, /PaintHolding/);
  assert.doesNotMatch(features, /HttpsUpgrades|ThirdPartyStoragePartitioning/);
});

test('site permissions open in their own running desktop environment', async () => {
  const dir = temp();
  try {
    const store = new ProfileStore(dir), manager = new BrowserManager(store);
    const chromium = store.create(), firefox = store.create({ fingerprintMode: 'kernel' });
    await assert.rejects(manager.openSitePermissions(chromium.id), { status: 409 });
    const navigations = [];
    manager.sessions.set(chromium.id, { headless: false, context: {
      newPage: async () => ({ goto: async url => navigations.push([chromium.id, url]), bringToFront: async () => {} }),
    } });
    const frame = {};
    manager.sessions.set(firefox.id, { headless: false, context: {
      newPage: async () => ({ bringToFront: async () => navigations.push([firefox.id, 'focused']), _connection: { toImpl: () => ({
        mainFrame: () => frame,
        delegate: { navigateFrame: async (target, url) => { assert.equal(target, frame); navigations.push([firefox.id, url]); } },
      }) } }),
    } });
    await manager.openSitePermissions(firefox.id);
    await manager.openSitePermissions(chromium.id);
    assert.deepEqual(navigations, [[firefox.id, 'focused'], [firefox.id, 'about:preferences#privacy'], [chromium.id, 'chrome://settings/content']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bulk proxy detection discards a result when its proxy is edited in flight', async () => {
  const dir = temp(), ready = Promise.withResolvers(), probe = Promise.withResolvers();
  const backend = buildBackend(dir, { checkProxy: proxy => {
    ready.resolve(proxy);
    return probe.promise;
  } });
  const server = http.createServer(backend.app.callback());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (endpoint, method, body) => fetch(`http://127.0.0.1:${server.address().port}/api${endpoint}`, {
    method, headers: { 'x-api-token': backend.token, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const record = backend.proxyStore.add({ type: 'http', host: 'old.example', port: 8080 });
    const pending = request('/proxies/check', 'POST', { ids: [record.id] });
    assert.equal((await ready.promise).host, 'old.example');
    assert.equal((await request('/proxies/' + record.id, 'PATCH', { host: 'new.example' })).status, 200);
    probe.resolve({ status: 'ok', exitIp: '192.0.2.7' });
    const { results } = await (await pending).json();
    assert.equal(results[0].status, 'failed');
    assert.equal(backend.proxyStore.get(record.id).exitIp, null);
    assert.equal(backend.proxyStore.get(record.id).status, 'unchecked');
    const older = backend.proxyStore.beginCheck(record.id), newer = backend.proxyStore.beginCheck(record.id);
    assert.equal(newer.save({ status: 'ok', exitIp: '192.0.2.9' }), true);
    assert.equal(older.save({ status: 'ok', exitIp: '192.0.2.8' }), false);
    assert.equal(backend.proxyStore.get(record.id).exitIp, '192.0.2.9');
  } finally {
    probe.resolve({ status: 'failed' });
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('interrupted profile cleanup stays listed and is retryable after a restart', async t => {
  const dir = temp();
  try {
    const store = new ProfileStore(dir);
    const profile = store.create({ name: 'deletion fixture' });
    const directory = store.profileDir(profile.id);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'session-fixture'), 'present');
    const remove = fs.rmSync;
    const fixture = t.mock.method(fs, 'rmSync', (target, options) => {
      if (target === directory) throw Object.assign(new Error('directory busy'), { code: 'EBUSY' });
      return remove(target, options);
    });
    try { assert.throws(() => store.remove(profile.id), { status: 409, message: /重试删除/ }); }
    finally { fixture.mock.restore(); }
    const reopened = new ProfileStore(dir);
    assert.equal(reopened.get(profile.id).deleting, true);
    await assert.rejects(new BrowserManager(reopened).open(profile.id), { status: 409 });
    assert.throws(() => reopened.update(profile.id, { name: 'unexpected' }), { status: 409 });
    assert.equal(fs.existsSync(directory), true);
    assert.equal(reopened.remove(profile.id), true);
    assert.equal(reopened.get(profile.id), null);
    assert.equal(fs.existsSync(directory), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API uses header auth, rejects foreign origins, protects proxy references and redacts inline passwords', async () => {
  const dir = temp();
  let probe = { status: 'failed', code: 'PROXY_AUTH', error: '代理认证失败' };
  const b = buildBackend(dir, { checkProxy: async () => probe });
  const server = http.createServer(b.app.callback());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = (p, method = 'GET', body, headers = {}) => fetch(url + p, { method, headers: { 'x-api-token': b.token, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await fetch(url + '/profiles?token=' + b.token)).status, 401);
    assert.equal((await request('/profiles', 'GET', null, { origin: 'https://example.com' })).status, 403);
    const preflight = await fetch(url + '/profiles', { method: 'OPTIONS', headers: { origin: 'null', 'Access-Control-Request-Headers': 'x-api-token,content-type' } });
    assert.equal(preflight.status, 204);
    const p = b.store.create({ proxy: { server: 'http://127.0.0.1:9', password: 'fixture-secret' } });
    assert.ok(!(await (await request('/profiles')).text()).includes('fixture-secret'));
    const x = b.proxyStore.add({ type: 'http', host: '127.0.0.1', port: 9 });
    b.store.update(p.id, { proxyId: x.id });
    const checked = await (await request('/proxies/check', 'POST', { ids: [x.id] })).json();
    assert.equal(checked.results[0].code, 'PROXY_AUTH');
    assert.equal(b.proxyStore.get(x.id).checkCode, 'PROXY_AUTH');
    const blocked = await request('/openBrowser', 'POST', { profile_id: p.id });
    assert.equal(blocked.status, 502);
    assert.deepEqual(await blocked.json(), { ok: false, error: '代理认证失败', code: 'PROXY_AUTH' });
    probe = { status: 'ok', exitIp: '192.0.2.5', countryCode: null, timezone: null };
    const noRegion = await request('/openBrowser', 'POST', { profile_id: p.id });
    assert.equal(noRegion.status, 409);
    assert.equal((await noRegion.json()).code, 'PROXY_REGION');
    assert.equal(b.proxyStore.get(x.id).checkCode, null);
    assert.equal(b.browsers.isOpen(p.id), false);
    assert.equal((await request('/proxies/' + x.id, 'DELETE')).status, 409);
    assert.equal((await request('/profiles/' + p.id, 'PATCH', { proxyId: null })).status, 200);
    assert.equal((await request('/proxies/' + x.id, 'DELETE')).status, 200);
  } finally { await b.browsers.closeAll(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
