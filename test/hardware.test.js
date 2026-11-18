'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProfileStore } = require('../src/store');
const { HOST_PLATFORM } = require('../src/fingerprint');
const { generateHardware, hardwareConfig, hardwareOptions } = require('../src/hardware');
const { nativeConfig } = require('../src/nativecore');
const { userAgentPresets, resolveUserAgent, isUserAgentAllowed } = require('../src/user-agents');

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

test('random generation uses every supported CPU and memory choice once per pool index', (t) => {
  const cpus = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32];
  const memories = [4, 8, 16, 32, 48, 64, 96];
  const indexes = new Map();
  t.mock.method(crypto, 'randomInt', size => indexes.get(size) ?? 0);

  assert.deepEqual(hardwareOptions().cpus, [2, ...cpus]);
  assert.deepEqual(hardwareOptions().memories, [0.5, 1, 2, ...memories]);
  for (const [index, cpu] of cpus.entries()) {
    indexes.set(cpus.length, index);
    assert.equal(hardwareConfig(generateHardware()).hardwareConcurrency, cpu);
  }
  for (const [index, memory] of memories.entries()) {
    indexes.set(memories.length, index);
    assert.equal(hardwareConfig(generateHardware()).deviceMemory, memory);
  }
});

test('each simulated GPU preset is selectable and can be generated', (t) => {
  const presets = hardwareOptions().gpus.filter(({ id }) => id !== 'native');
  assert.equal(presets.length, 28);
  let gpuIndex = 0;
  t.mock.method(crypto, 'randomInt', size => size === presets.length ? gpuIndex : 0);

  for (const [index, preset] of presets.entries()) {
    gpuIndex = index;
    const profile = generateHardware();
    assert.equal(profile.gpuPreset, preset.id);
    assert.equal(hardwareConfig(profile).gpu.name, preset.name);
  }

  const { gpu } = hardwareConfig({ ...generateHardware(), gpuPreset: 'apple-m4-pro' });
  assert.equal(gpu.renderer, 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)');
  assert.equal(gpu.webgpuVendor, 'apple');
});

test('User-Agent presets are unique and random selection is scoped to the platform and engine', (t) => {
  const values = new Set();
  let index = 0;
  t.mock.method(crypto, 'randomInt', () => index);

  for (const [platform, count] of [['win', 30], ['mac', 10]]) {
    const presets = userAgentPresets(platform);
    for (const [fingerprintMode, entries] of Object.entries(presets)) {
      assert.equal(entries.length, count);
      for (index = 0; index < entries.length; index++) {
        const userAgent = entries[index][1];
        const profile = { platform, fingerprintMode, userAgent };
        assert.equal(resolveUserAgent(profile, 'random'), userAgent);
        assert.equal(isUserAgentAllowed(profile), true);
        assert.equal(isUserAgentAllowed({ ...profile, platform: platform === 'win' ? 'mac' : 'win' }), false);
        assert.equal(isUserAgentAllowed({ ...profile, fingerprintMode: fingerprintMode === 'hardware' ? 'kernel' : 'hardware' }), false);
        assert.ok(!values.has(userAgent));
        values.add(userAgent);
      }
    }
  }
  assert.equal(values.size, 80);
  assert.equal(resolveUserAgent({ platform: 'linux', fingerprintMode: 'hardware' }, 'random'), null);
  assert.equal(resolveUserAgent({ platform: 'win', fingerprintMode: 'native' }, 'random'), null);
});

test('creating a simulated profile assigns its UA once, and explicit changes persist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cike-user-agent-'));
  try {
    const store = new ProfileStore(dir);
    const presets = userAgentPresets(HOST_PLATFORM);
    for (const fingerprintMode of ['hardware', 'kernel']) {
      const profile = store.create({ fingerprintMode });
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
