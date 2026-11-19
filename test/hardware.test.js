'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProfileStore } = require('../src/store');
const { HOST_PLATFORM, buildContextOptions } = require('../src/fingerprint');
const { generateHardware, hardwareConfig, hardwareOptions } = require('../src/hardware');
const { installHardwareContext } = require('../src/hardware-runtime');
const { nativeConfig } = require('../src/nativecore');
const { userAgentPresets, resolveUserAgent, isUserAgentAllowed } = require('../src/user-agents');
const { COUNTRY_LOCALE, LOCALES, TIMEZONES } = require('../src/localemap');

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

test('worker startup rejects genuine errors and preserves the environment for disposed workers', async (t) => {
  class Session extends EventEmitter {
    constructor(connection, id) {
      super();
      this._connection = connection;
      this._sessionId = id;
    }
    createChildSession(id) { return new Session(this._connection, id); }
    async send(method) {
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
  const presets = hardwareOptions().gpus.filter(({ id }) => id !== 'native');
  assert.equal(presets.length, 46);
  let gpuIndex = 0;
  const poolSizes = new Set([5, presets.length - 5]);
  t.mock.method(crypto, 'randomInt', size => poolSizes.has(size) ? gpuIndex : 0);
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'arm64']]) {
    const pool = presets.filter(({ id }) => id.startsWith('apple-') === (platform === 'darwin'));
    for (const [index, preset] of pool.entries()) {
      gpuIndex = index;
      assert.equal(generateHardware(platform, arch).gpuPreset, preset.id);
    }
  }
  assert.equal(generateHardware('darwin', 'x64').gpuPreset, 'native');
  gpuIndex = 0;
  const { gpu } = hardwareConfig({ ...generateHardware(), gpuPreset: 'apple-m4-pro' });
  assert.equal(gpu.renderer, 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)');
  assert.equal(gpu.webgpuVendor, 'apple');
});

test('User-Agent presets are unique and random selection is scoped to the platform and engine', (t) => {
  const values = new Set();
  let index = 0;
  t.mock.method(crypto, 'randomInt', () => index);

  for (const [platform, counts] of [['win', { hardware: 31, kernel: 32 }], ['mac', { hardware: 14, kernel: 17 }]]) {
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
      for (index = 0; index < compatible.length; index++) {
        assert.equal(resolveUserAgent({ platform, fingerprintMode }, 'random'), compatible[index][1]);
      }
    }
  }
  assert.equal(values.size, 94);
  assert.equal(resolveUserAgent({ platform: 'linux', fingerprintMode: 'hardware' }, 'random'), null);
  assert.equal(resolveUserAgent({ platform: 'win', fingerprintMode: 'native' }, 'random'), null);
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

test('two automatic creations persist fresh settings and keep manual creation available', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-random-profiles-'));
  try {
    const store = new ProfileStore(dir);
    const first = store.create({ fingerprintMode: 'random', locale: 'zh-CN' });
    const second = store.create({ fingerprintMode: 'random' });
    const reopened = new ProfileStore(dir);
    for (const profile of [first, second]) {
      assert.equal(profile.fingerprintMode, 'hardware');
      assert.equal(profile.canvasNoise, true);
      assert.equal(profile.audioNoise, true);
      assert.match(profile.fingerprintSeed, /^[a-f0-9]{32}$/);
      assert.deepEqual(reopened.get(profile.id), profile);
    }
    assert.equal(first.locale, 'zh-CN');
    assert.notEqual(first.fingerprintSeed, second.fingerprintSeed);
    if (first.gpuPreset !== 'native') assert.notEqual(first.gpuPreset, second.gpuPreset);
    if (HOST_PLATFORM === 'win') {
      assert.notDeepEqual(first.display, second.display);
      assert.notDeepEqual(buildContextOptions(first).options.viewport, buildContextOptions(second).options.viewport);
    }
    assert.equal(store.create({}).fingerprintMode, 'native');
    assert.throws(() => store.update(first.id, { fingerprintMode: 'random' }), { status: 400 });
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

test('switching a simulated profile to native clears inherited hardware overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-hardware-native-switch-'));
  try {
    const store = new ProfileStore(dir);
    for (const fingerprintMode of ['hardware', 'kernel']) {
      const profile = store.create({ fingerprintMode, hardwareConcurrency: 4, gpuPreset: 'nvidia-rtx-3060', locale: 'zh-CN' });
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
