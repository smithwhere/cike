'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HOST_PLATFORM, validateProfile } = require('./fingerprint');
const { privateDirectory, readJSON, writeJSON, credentials } = require('./privatefiles');
const { validateInlineProxy } = require('./proxyconfig');
const { GPU_PRESETS, completeHardware, generateHardware, isGpuPresetAllowed } = require('./hardware');
const { randomWindowOptions } = require('./display-presets');
const { resolveUserAgent } = require('./user-agents');

const DEFAULT_SPEC = {
  name: 'profile', group: '', fingerprintMode: 'native', platform: HOST_PLATFORM,
  userAgent: null, proxyId: null, proxy: null,
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, display: null,
  locale: 'auto', timezone: 'auto', canvasSeed: null, canvasNoise: false,
  hardwareConcurrency: null, deviceMemory: null, webrtc: 'auto', colorScheme: 'light', reducedMotion: 'no-preference',
  contrast: 'no-preference', forcedColors: 'none',
  gpuPreset: 'native', audioNoise: false, fingerprintSeed: null, canvasSiteProtection: false,
};
const pick = value => Object.fromEntries(Object.keys(DEFAULT_SPEC).filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));

function generateRandomProfile(spec, previous, workArea) {
  const choose = values => values[crypto.randomInt(values.length)];
  const window = randomWindowOptions(HOST_PLATFORM, previous?.display, workArea);
  return {
    ...window,
    timezone: 'ip',
    colorScheme: choose(['light', 'dark']),
    reducedMotion: choose(['no-preference', 'reduce']),
    contrast: choose(['no-preference', 'more']),
    forcedColors: choose(['none', 'active']),
    ...spec,
    ...generateHardware(process.platform, process.arch, previous?.gpuPreset),
    userAgent: 'random',
    display: window.display,
  };
}

class ProfileStore {
  constructor(dataDir, secretStorage, getDisplayWorkArea) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'profiles.json');
    this.codec = credentials(secretStorage);
    this.getDisplayWorkArea = getDisplayWorkArea;
    this.networkChecks = new Map();
    privateDirectory(dataDir);
    privateDirectory(path.join(dataDir, 'profiles'));
    this.profiles = readJSON(this.file, {});
    for (const [id, p] of Object.entries(this.profiles)) {
      this.profileDir(id); // Reject traversal in existing records as well.
      if (p.id !== id) throw new Error('环境记录 ID 不一致');
      if (p.proxy) p.proxy.password = this.codec.decode(p.proxy.password);
      p.fingerprintMode ||= 'legacy';
      p.canvasSiteProtection ??= false;
      const scale = typeof p.deviceScaleFactor === 'string' ? Number(p.deviceScaleFactor) : p.deviceScaleFactor;
      p.deviceScaleFactor = Number.isFinite(scale) && scale >= 0.5 && scale <= 4 ? scale : DEFAULT_SPEC.deviceScaleFactor;
      if (['hardware', 'kernel'].includes(p.fingerprintMode)) {
        p.audioNoise = false;
        if (Object.hasOwn(GPU_PRESETS, p.gpuPreset) && !isGpuPresetAllowed(p.gpuPreset, p.fingerprintMode)) p.gpuPreset = 'native';
      }
    }
    this.sequenceFile = path.join(dataDir, 'profile-sequence.json');
    const saved = readJSON(this.sequenceFile, { last: 0 }).last || 0;
    const profiles = this.list();
    // The saved counter can outlive the last profile, including on older installations.
    this.sequence = profiles.length
      ? Math.max(saved, profiles.length, ...profiles.map(p => Number(p.sequence) || (/^\d+$/.test(p.name) ? Number(p.name) : 0)))
      : 0;
    for (const p of profiles) {
      if (!Number.isSafeInteger(p.sequence) || p.sequence < 1) this.profiles[p.id].sequence = ++this.sequence;
    }
    if (fs.existsSync(this.file)) this._save();
  }
  _save() {
    const records = structuredClone(this.profiles);
    for (const p of Object.values(records)) if (p.proxy) p.proxy.password = this.codec.encode(p.proxy.password);
    writeJSON(this.file, records);
  }
  create(spec = {}) {
    const random = spec.fingerprintMode === 'random';
    const previous = random ? Object.values(this.profiles).at(-1) : null;
    if (random) spec = generateRandomProfile(spec, previous, this.getDisplayWorkArea?.());
    const id = 'p_' + crypto.randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    const sequence = this.sequence + 1;
    const record = completeHardware({ ...structuredClone(DEFAULT_SPEC), ...pick(spec), id,
      name: String(spec.name || '').trim() || String(sequence), sequence,
      viewport: { ...DEFAULT_SPEC.viewport, ...spec.viewport }, createdAt: now, updatedAt: now }, spec);
    const priorAgent = record.userAgent === 'random-preset'
      ? Object.values(this.profiles).findLast(p => p.fingerprintMode === record.fingerprintMode && p.userAgent)?.userAgent
      : previous?.userAgent;
    record.userAgent = resolveUserAgent(record, record.userAgent, priorAgent);
    validateProfile(record);
    if (record.proxy) validateInlineProxy(record.proxy);
    writeJSON(this.sequenceFile, { last: sequence });
    this.sequence = sequence;
    this.profiles[id] = record;
    try { this._save(); } catch (error) {
      delete this.profiles[id];
      if (Object.keys(this.profiles).length === 0) this.sequence = 0;
      throw error;
    }
    return structuredClone(record);
  }
  list() { return Object.values(this.profiles).map(p => structuredClone(p)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.sequence || 0) - (b.sequence || 0)); }
  get(id) { return Object.hasOwn(this.profiles, id) ? structuredClone(this.profiles[id]) : null; }
  update(id, patch = {}) {
    const old = this.get(id);
    if (!old) return null;
    if (old.deleting) throw Object.assign(new Error('环境正在等待清理，不能编辑'), { status: 409 });
    const changes = pick(patch);
    let next = { ...old, ...changes, updatedAt: new Date().toISOString() };
    if (old.fingerprintMode === 'legacy' && ['native', 'hardware', 'kernel'].includes(patch.fingerprintMode)) {
      // Keep non-secret former fingerprint settings for reference. Never put
      // proxy credentials into a second unencrypted copy.
      const keys = ['platform', 'userAgent', 'canvasSeed', 'canvasNoise', 'hardwareConcurrency', 'deviceMemory', 'webrtc'];
      next.previousFingerprint = Object.fromEntries(keys.map(k => [k, old[k] ?? null]));
      Object.assign(next, { platform: HOST_PLATFORM, userAgent: null, canvasNoise: false, canvasSeed: null,
        hardwareConcurrency: null, deviceMemory: null, webrtc: patch.webrtc || (old.webrtc === 'disabled' ? 'restricted' : old.webrtc || 'auto') },
        changes, { platform: HOST_PLATFORM });
    } else if (changes.fingerprintMode === 'native' && ['hardware', 'kernel'].includes(old.fingerprintMode)) {
      const { hardwareConcurrency, deviceMemory, gpuPreset, canvasNoise, audioNoise } = DEFAULT_SPEC;
      Object.assign(next, { hardwareConcurrency, deviceMemory, gpuPreset, canvasNoise, audioNoise }, changes);
    }
    if (next.fingerprintMode !== 'kernel' && !Object.hasOwn(changes, 'canvasSiteProtection')) {
      next.canvasSiteProtection = false;
    }
    if (next.fingerprintMode === 'kernel' && old.fingerprintMode !== 'kernel' && !Object.hasOwn(changes, 'gpuPreset')) next.gpuPreset = 'native';
    next = completeHardware(next, old.fingerprintMode === 'hardware' ? { ...old, ...patch } : patch);
    if (old.fingerprintMode !== 'legacy' || next.fingerprintMode !== 'legacy') {
      const choice = next.fingerprintMode !== old.fingerprintMode && !Object.hasOwn(changes, 'userAgent') ? null : next.userAgent;
      next.userAgent = resolveUserAgent(next, choice, choice === 'random-preset' ? old.userAgent : undefined);
      validateProfile(next);
    }
    if (next.proxy) {
      next.proxy = { ...next.proxy };
      if (patch.proxy && !Object.hasOwn(patch.proxy, 'password') && old.proxy?.server === next.proxy.server && (old.proxy?.username || '') === (next.proxy.username || '')) next.proxy.password = old.proxy.password;
      validateInlineProxy(next.proxy);
    }
    if (Object.hasOwn(patch, 'proxyId') || Object.hasOwn(patch, 'proxy')) next.lastNetwork = null;
    this.profiles[id] = next;
    try { this._save(); } catch (error) { this.profiles[id] = old; throw error; }
    this.networkChecks.delete(id);
    return structuredClone(next);
  }
  recordOpened(id, network) {
    const p = this.get(id);
    if (!p) throw new Error('环境不存在');
    if (p.deleting) throw Object.assign(new Error('环境正在等待清理'), { status: 409 });
    this.profiles[id] = { ...p, lastOpenedAt: new Date().toISOString(), ...(network ? { lastNetwork: network } : {}) };
    try { this._save(); } catch (error) { this.profiles[id] = p; throw error; }
  }
  recordNetwork(id, network) {
    const p = this.get(id);
    if (!p || p.deleting) return;
    this.profiles[id] = { ...p, lastNetwork: network };
    try { this._save(); } catch (error) { this.profiles[id] = p; throw error; }
  }
  beginNetworkCheck(id) {
    const token = Symbol();
    this.networkChecks.set(id, token);
    const current = () => this.networkChecks.get(id) === token && !!this.profiles[id] && !this.profiles[id].deleting;
    return {
      current,
      save: network => {
        if (!current()) return false;
        this.recordNetwork(id, network);
        return true;
      },
    };
  }
  markDeleting(id) {
    const rec = this.get(id);
    if (!rec) return false;
    if (rec.deleting) return true;
    this.profiles[id] = { ...rec, deleting: true };
    try { this._save(); } catch (error) { this.profiles[id] = rec; throw error; }
    this.networkChecks.delete(id);
    return true;
  }
  remove(id) {
    if (!this.markDeleting(id)) return false;
    const rec = this.get(id);
    const app = path.join(require('./profileapp').appsRoot(this.dataDir), `CIKE-${rec.sequence}-${id}.app`);
    const cleanup = { recursive: true, force: true, maxRetries: 3, retryDelay: 150 };
    try {
      fs.rmSync(this.profileDir(id), cleanup);
      fs.rmSync(app, cleanup);
      fs.rmSync(app + '.json', cleanup);
      fs.rmSync(path.join(this.dataDir, 'diagnostics', id + '.json'), cleanup);
    } catch (error) {
      throw Object.assign(new Error('环境数据尚未清理，可关闭相关进程后重试删除', { cause: error }), { status: 409 });
    }
    delete this.profiles[id];
    try { this._save(); } catch (error) { this.profiles[id] = rec; throw error; }
    if (Object.keys(this.profiles).length === 0) this.sequence = 0;
    return true;
  }
  profileDir(id) {
    if (typeof id !== 'string' || !/^p_[a-f0-9]{12}$/.test(id)) throw new Error('无效的环境 ID');
    return path.join(this.dataDir, 'profiles', id);
  }
  public(record) {
    const p = structuredClone(record);
    if (p?.proxy) { p.proxy.hasAuth = !!p.proxy.password; delete p.proxy.password; }
    return p;
  }
}
module.exports = { ProfileStore, DEFAULT_SPEC };
