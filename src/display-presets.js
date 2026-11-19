'use strict';

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
];
const SCALES = [100, 125, 150, 175, 200];

function displayCatalog(platform) {
  return platform === 'win' ? { presets: PRESETS, scales: SCALES } : null;
}

function emulatedDisplay(display, platform) {
  if (display == null) return null;
  const preset = PRESETS.find(option => option.id === display.preset);
  if (platform !== 'win' || !preset || !SCALES.includes(display.scale) || Object.keys(display).length !== 2) {
    throw Object.assign(new Error('请选择有效的 Windows 显示测试预设和缩放比例'), { status: 400 });
  }
  const deviceScaleFactor = display.scale / 100;
  const screen = {
    width: Math.floor(preset.width / deviceScaleFactor),
    height: Math.floor(preset.height / deviceScaleFactor),
  };
  return { screen, viewport: { ...screen }, deviceScaleFactor };
}

module.exports = { displayCatalog, emulatedDisplay };
