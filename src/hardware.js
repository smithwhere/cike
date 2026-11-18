'use strict';
const crypto = require('crypto');

function gpuPreset(name, vendor, webgpuVendor) {
  const renderer = vendor === 'Apple' || process.platform === 'darwin'
    ? `ANGLE (${vendor}, ANGLE Metal Renderer: ${name}, Unspecified Version)`
    : process.platform === 'win32' ? `ANGLE (${vendor}, ${name} Direct3D11 vs_5_0 ps_5_0, D3D11)`
      : `ANGLE (${vendor}, ${name}, OpenGL 4.5)`;
  return { name, vendor: `Google Inc. (${vendor})`, renderer, webgpuVendor };
}
const GPU_PRESETS = {
  native: { name: '原生显卡', vendor: null, renderer: null },
  'intel-uhd': gpuPreset('Intel(R) UHD Graphics', 'Intel', 'intel'),
  'intel-uhd-630': gpuPreset('Intel(R) UHD Graphics 630', 'Intel', 'intel'),
  'intel-iris-xe': gpuPreset('Intel(R) Iris(R) Xe Graphics', 'Intel', 'intel'),
  'intel-arc': gpuPreset('Intel Arc Graphics', 'Intel', 'intel'),
  'nvidia-gtx-1650': gpuPreset('NVIDIA GeForce GTX 1650', 'NVIDIA', 'nvidia'),
  'nvidia-gtx-1660': gpuPreset('NVIDIA GeForce GTX 1660', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-3050': gpuPreset('NVIDIA GeForce RTX 3050', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-3060': gpuPreset('NVIDIA GeForce RTX 3060', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-4060': gpuPreset('NVIDIA GeForce RTX 4060', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-4060-ti': gpuPreset('NVIDIA GeForce RTX 4060 Ti', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-5060': gpuPreset('NVIDIA GeForce RTX 5060', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-5060-ti': gpuPreset('NVIDIA GeForce RTX 5060 Ti', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-5070': gpuPreset('NVIDIA GeForce RTX 5070', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-3060-laptop': gpuPreset('NVIDIA GeForce RTX 3060 Laptop GPU', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-4050-laptop': gpuPreset('NVIDIA GeForce RTX 4050 Laptop GPU', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-4060-laptop': gpuPreset('NVIDIA GeForce RTX 4060 Laptop GPU', 'NVIDIA', 'nvidia'),
  'nvidia-rtx-5060-laptop': gpuPreset('NVIDIA GeForce RTX 5060 Laptop GPU', 'NVIDIA', 'nvidia'),
  'amd-radeon-graphics': gpuPreset('AMD Radeon Graphics', 'AMD', 'amd'),
  'amd-rx-6600': gpuPreset('AMD Radeon RX 6600', 'AMD', 'amd'),
  'amd-rx-7600': gpuPreset('AMD Radeon RX 7600', 'AMD', 'amd'),
  'amd-rx-7800-xt': gpuPreset('AMD Radeon RX 7800 XT', 'AMD', 'amd'),
  'amd-rx-9060-xt': gpuPreset('AMD Radeon RX 9060 XT', 'AMD', 'amd'),
  'amd-rx-9070-xt': gpuPreset('AMD Radeon RX 9070 XT', 'AMD', 'amd'),
  'apple-m1': gpuPreset('Apple M1', 'Apple', 'apple'),
  'apple-m2': gpuPreset('Apple M2', 'Apple', 'apple'),
  'apple-m3': gpuPreset('Apple M3', 'Apple', 'apple'),
  'apple-m4': gpuPreset('Apple M4', 'Apple', 'apple'),
  'apple-m4-pro': gpuPreset('Apple M4 Pro', 'Apple', 'apple'),
};
const RANDOM_CPU_VALUES = [4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32];
const CPU_VALUES = [2, ...RANDOM_CPU_VALUES];
const MEMORY_VALUES = [0.5, 1, 2, 4, 8, 16, 32, 48, 64, 96];
const RANDOM_MEMORY_VALUES = [4, 8];
function hardwareOptions() {
  return { cpus: CPU_VALUES, memories: MEMORY_VALUES,
    gpus: Object.entries(GPU_PRESETS).map(([id, gpu]) => ({ id, name: gpu.name })) };
}
function generateHardware(platform = process.platform, arch = process.arch) {
  const choose = list => list[crypto.randomInt(list.length)];
  const gpuChoices = Object.keys(GPU_PRESETS).filter(id => id !== 'native' && id.startsWith('apple-') === (platform === 'darwin'));
  const gpuPreset = platform === 'darwin' && arch !== 'arm64' ? 'native' : choose(gpuChoices);
  return { fingerprintMode: 'hardware', hardwareConcurrency: choose(RANDOM_CPU_VALUES), deviceMemory: choose(RANDOM_MEMORY_VALUES),
    gpuPreset, canvasNoise: true, audioNoise: true, fingerprintSeed: crypto.randomBytes(16).toString('hex') };
}
function completeHardware(profile, patch = {}) {
  if (profile.fingerprintMode === 'kernel') return { ...profile,
    hardwareConcurrency: profile.hardwareConcurrency ?? 8, deviceMemory: null,
    gpuPreset: profile.gpuPreset || 'native', canvasNoise: false, audioNoise: false,
    fingerprintSeed: profile.fingerprintSeed || crypto.randomBytes(16).toString('hex') };
  if (profile.fingerprintMode !== 'hardware') return profile;
  return { ...profile, hardwareConcurrency: profile.hardwareConcurrency ?? 8, deviceMemory: profile.deviceMemory ?? 8,
    gpuPreset: profile.gpuPreset && profile.gpuPreset !== 'native' ? profile.gpuPreset : (Object.hasOwn(patch, 'gpuPreset') ? patch.gpuPreset : 'intel-uhd-630'),
    fingerprintSeed: profile.fingerprintSeed || crypto.randomBytes(16).toString('hex'),
    canvasNoise: Object.hasOwn(patch, 'canvasNoise') ? patch.canvasNoise : true,
    audioNoise: Object.hasOwn(patch, 'audioNoise') ? patch.audioNoise : true };
}
function validateHardware(profile) {
  if (!CPU_VALUES.includes(profile.hardwareConcurrency)) throw Object.assign(new Error('请选择有效的 CPU 线程数'), { status: 400 });
  if (!MEMORY_VALUES.includes(profile.deviceMemory)) throw Object.assign(new Error(`网页内存值须从 ${MEMORY_VALUES.join('、')} GB 中选择`), { status: 400 });
  if (!Object.hasOwn(GPU_PRESETS, profile.gpuPreset)) throw Object.assign(new Error('请选择有效的显卡标识'), { status: 400 });
  if (!/^[a-f0-9]{32}$/.test(profile.fingerprintSeed || '')) throw Object.assign(new Error('指纹种子格式无效'), { status: 400 });
  if (typeof profile.canvasNoise !== 'boolean' || typeof profile.audioNoise !== 'boolean') throw Object.assign(new Error('Canvas 和音频选项必须为布尔值'), { status: 400 });
}
function hardwareConfig(profile) {
  validateHardware(profile);
  return { hardwareConcurrency: profile.hardwareConcurrency, deviceMemory: profile.deviceMemory,
    gpu: GPU_PRESETS[profile.gpuPreset], canvasNoise: profile.canvasNoise, audioNoise: profile.audioNoise,
    seed: [0, 8, 16, 24].map(offset => parseInt(profile.fingerprintSeed.slice(offset, offset + 8), 16) >>> 0) };
}
module.exports = { GPU_PRESETS, CPU_VALUES, hardwareOptions, generateHardware, completeHardware, validateHardware, hardwareConfig };
