'use strict';
const crypto = require('node:crypto');

// October 2026 Steam/Statcounter surveys and representative display specifications.
const PRESETS = [
  { id: 'fhd', name: 'FHD', width: 1920, height: 1080, specs: '23.8 英寸 · IPS · 100 / 180 Hz · sRGB' },
  { id: 'qhd', name: 'QHD', width: 2560, height: 1440, specs: '27 英寸 · IPS / OLED · 120 / 144 / 240 Hz · SDR / HDR' },
  { id: 'wqxga', name: 'WQXGA 笔记本', width: 2560, height: 1600, specs: '16 英寸 · OLED · 165 / 240 Hz · DCI-P3 · HDR' },
  { id: 'uhd', name: '4K UHD', width: 3840, height: 2160, specs: '31.5 英寸 · IPS Black · 120 Hz · SDR / HDR' },
  { id: 'uwqhd', name: '超宽 QHD', width: 3440, height: 1440, specs: '34 英寸 · IPS Black · 120 Hz · sRGB / DCI-P3' },
  { id: 'wuxga', name: 'WUXGA', width: 1920, height: 1200, specs: '14 英寸笔记本 / 24 英寸显示器 · IPS · 60 / 100 Hz' },
  { id: 'hd', name: '旧设备兼容', width: 1366, height: 768 },
  { id: '2k8', name: '2.8K 笔记本', width: 2880, height: 1800, specs: '14 英寸 · OLED · 120 Hz · DCI-P3 · HDR' },
  { id: 'dqhd', name: '双 QHD 超宽', width: 5120, height: 1440, specs: '49 英寸 · IPS Black · 60 Hz · sRGB / DCI-P3' },
  { id: 'hd720', name: 'HD 紧凑显示', width: 1280, height: 720 },
  { id: 'wxga', name: 'WXGA 紧凑显示', width: 1280, height: 800 },
  { id: 'wxga-plus', name: 'WXGA+', width: 1440, height: 900 },
  { id: 'hd-plus', name: 'HD+', width: 1600, height: 900 },
  { id: 'wsxga-plus', name: 'WSXGA+', width: 1680, height: 1050 },
  { id: 'uwfhd', name: '超宽 FHD', width: 2560, height: 1080 },
  { id: 'uwqhd-plus', name: '超宽 QHD+', width: 3840, height: 1600, specs: '37.5 英寸曲面 · IPS Black' },
  { id: 'wquxga', name: '4K+ 笔记本', width: 3840, height: 2400, specs: '16 英寸 · IPS / OLED · 60 Hz · DCI-P3' },
  { id: '2k2', name: '2.2K 笔记本', width: 2240, height: 1400, specs: '14 英寸 · IPS · 60 Hz · sRGB' },
  { id: '3k2', name: '3.2K 笔记本', width: 3200, height: 2000, specs: '16 英寸 · 双层 OLED · 40–120 Hz VRR · DCI-P3' },
  { id: '5k2k', name: '5K2K 超宽', width: 5120, height: 2160, specs: '40 英寸 · Nano IPS Black · DCI-P3' },
];
const SCALES = [100, 125, 150, 175, 200, 225, 250, 300];
const MIN_CSS_SIZE = 320;
const RANDOM_DISPLAYS = [
  { preset: 'hd', scale: 100 }, { preset: 'fhd', scale: 100 }, { preset: 'fhd', scale: 125 },
  { preset: 'qhd', scale: 100 }, { preset: 'qhd', scale: 125 }, { preset: 'wqxga', scale: 125 },
  { preset: 'wuxga', scale: 125 }, { preset: 'uhd', scale: 175 },
];

function availableScales({ width, height }) {
  return SCALES.filter(scale => Math.min(width, height) * 100 >= MIN_CSS_SIZE * scale);
}

function displayCatalog(platform) {
  if (platform !== 'win') return null;
  return { presets: PRESETS.map(preset => ({ ...preset, scales: availableScales(preset) })), scales: SCALES };
}

function displayOptions(preset, scale) {
  const deviceScaleFactor = scale / 100;
  const screen = {
    width: Math.floor(preset.width / deviceScaleFactor),
    height: Math.floor(preset.height / deviceScaleFactor),
  };
  return { screen, viewport: { ...screen }, deviceScaleFactor };
}

function randomWindowOptions(platform, previous) {
  const choices = RANDOM_DISPLAYS.filter(({ preset, scale }) => preset !== previous?.preset || scale !== previous?.scale);
  const display = choices[crypto.randomInt(choices.length)];
  const preset = PRESETS.find(option => option.id === display.preset);
  const { viewport, deviceScaleFactor } = displayOptions(preset, display.scale);
  return { display: platform === 'win' ? { ...display } : null, viewport, deviceScaleFactor };
}

function emulatedDisplay(display, platform) {
  if (display == null) return null;
  const preset = PRESETS.find(option => option.id === display.preset);
  if (platform !== 'win' || !preset || !availableScales(preset).includes(display.scale) || Object.keys(display).length !== 2) {
    throw Object.assign(new Error('请选择有效的 Windows 显示测试预设和缩放比例'), { status: 400 });
  }
  return displayOptions(preset, display.scale);
}

module.exports = { displayCatalog, emulatedDisplay, randomWindowOptions };
