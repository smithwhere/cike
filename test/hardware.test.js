'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { ProfileStore } = require('../src/store');
const { HOST_PLATFORM, buildContextOptions } = require('../src/fingerprint');
const { GPU_PRESETS, generateHardware, hardwareConfig, hardwareOptions, isGpuPresetAllowed } = require('../src/hardware');
const { installHardwareContext } = require('../src/hardware-runtime');
const { hardwareScript } = require('../src/hardware-script');
const { nativeConfig } = require('../src/nativecore');
const { userAgentPresets, currentUserAgents, resolveUserAgent, isUserAgentAllowed } = require('../src/user-agents');
const { COUNTRY_LOCALE, LOCALES, TIMEZONES } = require('../src/localemap');

test('canvas exports preserve native rejection and bypass processing for wide gamut and large canvases', async () => {
  const realm = vm.createContext({ DOMException });
  vm.runInContext(`
    class Navigator { get hardwareConcurrency() { return 8; } }
    globalThis.navigator = new Navigator();
    globalThis.OffscreenCanvasRenderingContext2D = class {
      constructor(canvas, options) { this.canvas = canvas; this.options = options; }
      drawImage(source) { this.canvas.tainted = source.tainted; }
      getContextAttributes() { return this.options; }
      getImageData() {
        if (this.canvas.tainted) throw new DOMException('Tainted canvas', 'SecurityError');
        return { data: new Uint8ClampedArray([120, 180, 200, 255]), width: 1, height: 1 };
      }
      putImageData() {}
    };
    globalThis.OffscreenCanvas = class {
      constructor(width, height) { this.width = width; this.height = height; }
      getContext(_type, options) { return new OffscreenCanvasRenderingContext2D(this, options); }
      convertToBlob() {
        return this.tainted ? Promise.reject(new DOMException('Tainted canvas', 'SecurityError')) : Promise.resolve(this);
      }
    };
    function sample(width, height, options) {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d', options);
      return canvas;
    }
  `, realm);
  vm.runInContext(hardwareScript({ hardwareConcurrency: 4, canvasNoise: true, gpu: {}, seed: [1, 2, 3, 4] }), realm);
  const tainted = vm.runInContext('const canvas = sample(1, 1); canvas.tainted = true; canvas', realm);
  let pending;
  assert.doesNotThrow(() => { pending = tainted.convertToBlob(); });
  await assert.rejects(pending, { name: 'SecurityError' });
  for (const options of ['1, 1, { colorSpace: "display-p3" }', '1, 1, { colorType: "float16" }', '4097, 4097']) {
    const canvas = vm.runInContext(`sample(${options})`, realm);
    assert.equal(await canvas.convertToBlob(), canvas);
  }
  const normal = vm.runInContext('sample(1, 1)', realm);
  assert.notEqual(await normal.convertToBlob(), normal);
});

test('hardware settings have stable per-profile seeds and preserve explicit choices on edits and restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-hardware-store-'));
  try {
    const store = new ProfileStore(dir);
    const a = store.create({ fingerprintMode: 'hardware', hardwareConcurrency: 4, deviceMemory: 4, canvasNoise: false, audioNoise: false, gpuPreset: 'native' });
    const b = store.create({ fingerprintMode: 'hardware' });
    assert.notEqual(a.fingerprintSeed, b.fingerprintSeed);
    assert.equal(a.fingerprintSeed.length, 32);
    const updated = store.update(a.id, { name: 'renamed' });
    assert.equal(updated.fingerprintSeed, a.fingerprintSeed);
    assert.equal(updated.canvasNoise, false);
    assert.equal(updated.audioNoise, false);
    assert.equal(updated.gpuPreset, 'native');
    assert.equal(new ProfileStore(dir).get(a.id).fingerprintSeed, a.fingerprintSeed);
    assert.throws(() => store.update(a.id, { hardwareConcurrency: -1 }), /CPU/);
    assert.throws(() => store.update(a.id, { deviceMemory: 128 }), /内存/);
    assert.throws(() => store.update(a.id, { gpuPreset: '__proto__' }), /显卡/);
    assert.throws(() => store.update(a.id, { fingerprintSeed: 'bad' }), /种子/);
    assert.throws(() => store.update(a.id, { fingerprintMode: 'legacy' }), /转换/);
    assert.throws(() => store.create({ hardwareConcurrency: 4 }), /原生一致/);
    const generated = generateHardware();
    assert.ok(hardwareOptions().cpus.includes(generated.hardwareConcurrency));
    assert.equal(store.create(generated).fingerprintSeed, generated.fingerprintSeed);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('device scale is a finite number and older numeric strings migrate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-scale-store-'));
  try {
    const store = new ProfileStore(dir);
    const profile = store.create({ deviceScaleFactor: 1.25 });
    for (const invalid of ['2', true, [2], NaN, Infinity, 4.5]) {
      assert.throws(() => store.update(profile.id, { deviceScaleFactor: invalid }), { status: 400 });
    }
    const records = JSON.parse(fs.readFileSync(store.file));
    records[profile.id].deviceScaleFactor = '1.25';
    fs.writeFileSync(store.file, JSON.stringify(records));
    const loaded = new ProfileStore(dir).get(profile.id);
    assert.equal(buildContextOptions(loaded).options.deviceScaleFactor, 1.25);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker startup rejects genuine errors and preserves the environment for disposed workers', async (t) => {
  class Session extends EventEmitter {
    constructor(connection, id) {
      super();
      this._connection = connection;
      this._sessionId = id;
    }
    createChildSession(id) { return new Session(this._connection, id); }
    async send(method) {
      assert.ok(!method.startsWith('Network.'), 'worker must use native request headers');
      if (method === 'Runtime.enable') throw this.failure;
      return {};
    }
  }

  const connection = { _sessions: new Map() };
  const root = connection.rootSession = new Session(connection, '');
  connection._sessions.set('', root);
  const context = new EventEmitter();
  context._connection = { toImpl: () => ({ _browser: { _connection: connection } }) };
  context.addInitScript = async () => {};
  context.pages = () => [];
  let closes = 0;
  context.close = async () => { closes++; context.emit('close'); };
  t.mock.method(console, 'error', () => {});
  await installHardwareContext(context, generateHardware());

  for (const [id, closed, type, expectedCloses] of [['closed', true, 'closed', 0], ['active', false, 'error', 1]]) {
    root.emit('Target.attachedToTarget', { sessionId: id, targetInfo: { type: 'worker' } });
    const worker = root.createChildSession(id);
    worker._closed = closed;
    worker.failure = Object.assign(new Error(id), { type });
    await assert.rejects(worker.send('Runtime.runIfWaitingForDebugger'), error => error === worker.failure);
    assert.equal(closes, expectedCloses);
  }
});

test('random generation uses every supported CPU and memory choice once per pool index', (t) => {
  const cpus = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32];
  const memories = [4, 8, 16, 32];
  const indexes = new Map();
  t.mock.method(crypto, 'randomInt', size => indexes.get(size) ?? 0);

  assert.deepEqual(hardwareOptions().cpus, [2, ...cpus]);
  assert.deepEqual(hardwareOptions().memories, [0.5, 1, 2, 4, 8, 16, 32, 48, 64, 96]);
  for (const [index, cpu] of cpus.entries()) {
    indexes.set(cpus.length, index);
    assert.equal(hardwareConfig(generateHardware()).hardwareConcurrency, cpu);
  }
  for (const [index, memory] of memories.entries()) {
    indexes.set(memories.length, index);
    assert.equal(hardwareConfig(generateHardware()).deviceMemory, memory);
  }
});

test('simulated GPU presets remain selectable, with platform-specific random pools', (t) => {
  const presets = Object.keys(GPU_PRESETS).filter(id => id !== 'native');
  assert.equal(presets.length, 46);
  let gpuIndex = 0;
  const poolSizes = new Set([5, presets.length - 5]);
  t.mock.method(crypto, 'randomInt', size => poolSizes.has(size) ? gpuIndex : 0);
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'arm64']]) {
    const pool = presets.filter(id => id.startsWith('apple-') === (platform === 'darwin'));
    for (const [index, id] of pool.entries()) {
      gpuIndex = index;
      assert.equal(generateHardware(platform, arch).gpuPreset, id);
      assert.equal(isGpuPresetAllowed(id, 'hardware', platform, arch), true);
      assert.equal(isGpuPresetAllowed(id, 'kernel', platform, arch), false);
    }
  }
  assert.equal(generateHardware('darwin', 'x64').gpuPreset, 'native');
  assert.equal(isGpuPresetAllowed('apple-m4-pro', 'hardware', 'win32', 'x64'), false);
  assert.equal(isGpuPresetAllowed('apple-m4-pro', 'hardware', 'linux', 'x64'), false);
  assert.equal(isGpuPresetAllowed('intel-uhd', 'hardware', 'darwin', 'arm64'), false);
  assert.deepEqual(hardwareOptions().gpus.map(({ id }) => id), ['native', ...presets.filter(id =>
    id.startsWith('apple-') === (process.platform === 'darwin' && process.arch === 'arm64'))]);
});

test('User-Agent presets are unique and random selection is scoped to the platform and engine', (t) => {
  const values = new Set();
  let index = 0;
  t.mock.method(crypto, 'randomInt', () => index);

  for (const [platform, counts] of [['win', { hardware: 61, kernel: 45 }], ['mac', { hardware: 14, kernel: 17 }]]) {
    const presets = userAgentPresets(platform);
    for (const [fingerprintMode, entries] of Object.entries(presets)) {
      assert.equal(entries.length, counts[fingerprintMode]);
      for (const [, userAgent] of entries) {
        const profile = { platform, fingerprintMode, userAgent };
        assert.equal(isUserAgentAllowed(profile), true);
        assert.equal(isUserAgentAllowed({ ...profile, platform: platform === 'win' ? 'mac' : 'win' }), false);
        assert.equal(isUserAgentAllowed({ ...profile, fingerprintMode: fingerprintMode === 'hardware' ? 'kernel' : 'hardware' }), false);
        assert.ok(!values.has(userAgent));
        values.add(userAgent);
      }
      const compatible = entries.filter(([, ua]) => /(?:Chrome|Firefox)\/158\./.test(ua));
      assert.ok(compatible.length);
      if (platform === 'win' && fingerprintMode === 'hardware') assert.equal(compatible.length, 6);
      for (index = 0; index < compatible.length; index++) {
        assert.equal(resolveUserAgent({ platform, fingerprintMode }, 'random'), compatible[index][1]);
      }
    }
  }
  assert.equal(values.size, 137);
  const windows = { platform: 'win', fingerprintMode: 'hardware' };
  const selectable = new Set(userAgentPresets('win', { includeLegacy: false }).hardware.map(([, value]) => value));
  assert.equal(selectable.size, 53);
  assert.ok(currentUserAgents(windows).every(([, value]) => selectable.has(value)));
  assert.ok([...selectable].every(userAgent => isUserAgentAllowed({ ...windows, userAgent })));
  assert.equal(resolveUserAgent({ platform: 'linux', fingerprintMode: 'hardware' }, 'random'), null);
  assert.equal(resolveUserAgent({ platform: 'win', fingerprintMode: 'native' }, 'random'), null);
});

test('Windows manual presets include 30 stable majors each for Chrome and Firefox', () => {
  const { hardware, kernel } = userAgentPresets('win', { includeLegacy: false });
  const chrome = hardware.filter(([name]) => /^Google Chrome \d+$/.test(name)).map(([, ua]) => ua);
  const firefox = kernel.filter(([, ua]) => ua.startsWith('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:')).map(([, ua]) => ua);

  assert.deepEqual(chrome, Array.from({ length: 30 }, (_, index) =>
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${158 - index}.0.0.0 Safari/537.36`));
  assert.deepEqual(firefox, Array.from({ length: 30 }, (_, index) =>
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${160 - index}.0) Gecko/20100101 Firefox/${160 - index}.0`));
});

test('region and appearance choices survive reopening and feed browser context options', () => {
  for (const locale of Object.values(COUNTRY_LOCALE)) assert.ok(LOCALES.includes(locale));
  assert.equal(Intl.getCanonicalLocales(LOCALES).length, LOCALES.length);
  assert.equal(new Set(TIMEZONES).size, TIMEZONES.length);
  for (const timeZone of TIMEZONES) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-appearance-'));
  try {
    const store = new ProfileStore(dir);
    const created = store.create({ locale: 'cs-CZ', timezone: 'Europe/Prague', colorScheme: 'dark', reducedMotion: 'reduce', contrast: 'more', forcedColors: 'active' });
    const saved = new ProfileStore(dir).get(created.id);
    const { options } = buildContextOptions(saved);
    assert.equal(options.locale, 'cs-CZ');
    assert.equal(options.timezoneId, 'Europe/Prague');
    assert.equal(options.colorScheme, 'dark');
    assert.equal(options.reducedMotion, 'reduce');
    assert.equal(options.contrast, 'more');
    assert.equal(options.forcedColors, 'active');
    assert.throws(() => store.update(created.id, { reducedMotion: 'invalid' }), { status: 400 });
    assert.throws(() => store.update(created.id, { contrast: 'less' }), { status: 400 });
    assert.throws(() => store.update(created.id, { forcedColors: true }), { status: 400 });
    const reset = store.update(created.id, { colorScheme: null, reducedMotion: null, contrast: null, forcedColors: null });
    const resetOptions = buildContextOptions(reset).options;
    for (const key of ['colorScheme', 'reducedMotion', 'contrast', 'forcedColors']) assert.equal(resetOptions[key], null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two automatic creations persist fresh settings and keep manual creation available', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-random-profiles-'));
  let lastChoice = false;
  t.mock.method(crypto, 'randomInt', size => lastChoice ? size - 1 : 0);
  try {
    const store = new ProfileStore(dir);
    const first = store.create({ fingerprintMode: 'random' });
    lastChoice = true;
    const second = store.create({ fingerprintMode: 'random' });
    const reopened = new ProfileStore(dir);
    const agents = currentUserAgents(first).map(([, value]) => value);
    for (const profile of [first, second]) {
      assert.equal(profile.fingerprintMode, 'hardware');
      assert.equal(profile.canvasNoise, true);
      assert.equal(profile.audioNoise, false);
      assert.ok([4, 8, 16, 32].includes(profile.deviceMemory));
      assert.ok(agents.length ? agents.includes(profile.userAgent) : profile.userAgent === null);
      assert.ok(LOCALES.includes(profile.locale));
      assert.equal(profile.timezone, 'ip');
      assert.equal(profile.webrtc, 'auto');
      const { options } = buildContextOptions(profile);
      assert.equal(options.extraHTTPHeaders, undefined);
      assert.equal(options.locale, profile.locale);
      assert.equal(options.timezoneId, undefined);
      assert.deepEqual(options.viewport, profile.viewport);
      assert.equal(options.deviceScaleFactor, profile.deviceScaleFactor);
      assert.match(profile.fingerprintSeed, /^[a-f0-9]{32}$/);
      assert.deepEqual(reopened.get(profile.id), profile);
    }
    for (const key of ['deviceMemory', 'hardwareConcurrency', 'locale', 'colorScheme', 'reducedMotion', 'contrast', 'forcedColors']) {
      assert.notEqual(first[key], second[key], key);
    }
    if (agents.length > 1) assert.notEqual(first.userAgent, second.userAgent);
    assert.notEqual(first.fingerprintSeed, second.fingerprintSeed);
    if (first.gpuPreset !== 'native') assert.notEqual(first.gpuPreset, second.gpuPreset);
    assert.notDeepEqual(first.viewport, second.viewport);
    if (HOST_PLATFORM === 'win') {
      assert.notDeepEqual(first.display, second.display);
    }
    const third = reopened.create({ fingerprintMode: 'random' });
    if (agents.length > 1) assert.notEqual(second.userAgent, third.userAgent);
    else assert.equal(third.userAgent, second.userAgent);
    const customized = reopened.create({ fingerprintMode: 'random', locale: 'zh-CN', colorScheme: 'dark' });
    assert.equal(customized.locale, 'zh-CN');
    assert.equal(customized.timezone, 'ip');
    assert.equal(customized.colorScheme, 'dark');
    assert.equal(reopened.create({}).fingerprintMode, 'native');
    assert.throws(() => reopened.update(first.id, { fingerprintMode: 'random' }), { status: 400 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('new profiles default to native UA, and explicit UA choices persist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-user-agent-'));
  try {
    const store = new ProfileStore(dir);
    const presets = userAgentPresets(HOST_PLATFORM);
    for (const fingerprintMode of ['hardware', 'kernel']) {
      assert.equal(store.create({ fingerprintMode }).userAgent, null);
      const profile = store.create({ fingerprintMode, userAgent: 'random' });
      const entries = presets[fingerprintMode];
      if (entries.length) assert.ok(entries.some(([, value]) => value === profile.userAgent));
      else assert.equal(profile.userAgent, null);
      assert.equal(store.update(profile.id, { name: 'renamed' }).userAgent, profile.userAgent);
      assert.equal(new ProfileStore(dir).get(profile.id).userAgent, profile.userAgent);
      assert.throws(() => store.update(profile.id, { userAgent: 'unsupported' }), /User-Agent/);
      assert.equal(store.update(profile.id, { userAgent: null }).userAgent, null);
      if (entries.length) {
        const selected = store.update(profile.id, { userAgent: entries[0][1] });
        assert.equal(selected.userAgent, entries[0][1]);
        if (fingerprintMode === 'kernel') assert.equal(nativeConfig(selected)['navigator.userAgent'], selected.userAgent);
      }
      assert.equal(store.update(profile.id, { fingerprintMode: 'native' }).userAgent, null);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manual preset UA draws include earlier versions and avoid repeating the previous choice', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-preset-ua-'));
  t.mock.method(crypto, 'randomInt', size => size - 1);
  try {
    const store = new ProfileStore(dir);
    const presets = userAgentPresets(HOST_PLATFORM, { includeLegacy: false });
    for (const [fingerprintMode, entries] of Object.entries(presets)) {
      const first = store.create({ fingerprintMode, userAgent: 'random-preset' });
      const second = store.create({ fingerprintMode, userAgent: 'random-preset' });
      const expected = entries.at(-1)?.[1] ?? null;
      assert.equal(first.userAgent, expected);
      assert.equal(second.userAgent, entries.at(-2)?.[1] ?? expected);
      assert.equal(new ProfileStore(dir).get(second.id).userAgent, second.userAgent);
      assert.equal(store.update(second.id, { userAgent: 'random-preset' }).userAgent, expected);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('old incompatible GPU and audio settings can reopen with their environment data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-hardware-migration-'));
  try {
    const store = new ProfileStore(dir);
    const software = store.create({ fingerprintMode: 'hardware', deviceMemory: 48 });
    const kernel = store.create({ fingerprintMode: 'kernel' });
    const incompatible = process.platform === 'darwin' && process.arch === 'arm64' ? 'intel-uhd' : 'apple-m1';
    assert.throws(() => store.update(software.id, { gpuPreset: incompatible }), /显卡/);
    assert.throws(() => store.update(kernel.id, { gpuPreset: 'nvidia-rtx-3060' }), /显卡/);
    const records = JSON.parse(fs.readFileSync(store.file));
    Object.assign(records[software.id], { gpuPreset: incompatible, audioNoise: true });
    Object.assign(records[kernel.id], { gpuPreset: 'nvidia-rtx-3060', audioNoise: true });
    fs.mkdirSync(store.profileDir(software.id));
    const cookie = path.join(store.profileDir(software.id), 'cookie-fixture');
    fs.writeFileSync(cookie, 'kept');
    fs.writeFileSync(store.file, JSON.stringify(records));
    const reopened = new ProfileStore(dir);
    assert.deepEqual(reopened.get(software.id), software);
    assert.deepEqual(reopened.get(kernel.id), kernel);
    assert.equal(fs.readFileSync(cookie, 'utf8'), 'kept');
    assert.equal(buildContextOptions(reopened.get(software.id)).options.extraHTTPHeaders, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('switching a simulated profile to native clears inherited hardware overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-hardware-native-switch-'));
  try {
    const store = new ProfileStore(dir);
    for (const fingerprintMode of ['hardware', 'kernel']) {
      const gpuPreset = fingerprintMode === 'kernel' ? 'native' : hardwareOptions().gpus[1].id;
      const profile = store.create({ fingerprintMode, hardwareConcurrency: 4, gpuPreset, locale: 'zh-CN' });
      const edited = store.update(profile.id, { hardwareConcurrency: 6 });
      assert.equal(edited.hardwareConcurrency, 6);
      assert.equal(edited.fingerprintSeed, profile.fingerprintSeed);

      assert.throws(() => store.update(profile.id, { fingerprintMode: 'native', hardwareConcurrency: 8 }), /原生一致/);
      assert.equal(store.get(profile.id).fingerprintMode, fingerprintMode);

      const native = store.update(profile.id, { fingerprintMode: 'native' });
      assert.equal(native.fingerprintMode, 'native');
      assert.equal(native.hardwareConcurrency, null);
      assert.equal(native.deviceMemory, null);
      assert.equal(native.gpuPreset, 'native');
      assert.equal(native.canvasNoise, false);
      assert.equal(native.audioNoise, false);
      assert.equal(native.fingerprintSeed, profile.fingerprintSeed);
      assert.equal(native.locale, 'zh-CN');
      assert.deepEqual(new ProfileStore(dir).get(profile.id), native);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
