'use strict';
const { isUserAgentAllowed } = require('./user-agents');
const { emulatedDisplay } = require('./display-presets');
const { isAutomaticTimezone } = require('./localemap');
// Native mode preserves Chromium values. Hardware mode is explicit software
// emulation and must be installed in pages and workers before site scripts.
const HOST_PLATFORM = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform] || 'linux';
function bad(message) { throw Object.assign(new Error(message), { status: 400 }); }
function validateProfile(profile) {
  if (!['native', 'hardware', 'kernel'].includes(profile.fingerprintMode)) bad('旧环境需要先转换为原生一致模式；Cookie 和站点数据会保留');
  if (profile.canvasSiteProtection !== undefined && typeof profile.canvasSiteProtection !== 'boolean') bad('Canvas 站点保护必须是布尔值');
  if (profile.canvasSiteProtection && profile.fingerprintMode !== 'kernel') bad('Canvas 站点保护需要 Camoufox 内核');
  if (profile.platform !== HOST_PLATFORM) bad('环境平台必须与本机系统一致');
  if (!isUserAgentAllowed(profile)) bad('请选择与本机系统和浏览器内核匹配的 User-Agent 预设');
  if (profile.fingerprintMode === 'native' && (profile.canvasNoise || profile.hardwareConcurrency != null || profile.deviceMemory != null || profile.audioNoise || (profile.gpuPreset && profile.gpuPreset !== 'native'))) {
    bad('原生一致模式使用本机平台、UA、CPU、内存与 Canvas；不支持页面级伪装');
  }
  if (profile.fingerprintMode === 'hardware') require('./hardware').validateHardware(profile);
  if (profile.fingerprintMode === 'kernel') require('./nativecore').validateKernel(profile);
  if (!['auto', 'default', 'restricted'].includes(profile.webrtc)) bad('WebRTC 请选择自动、默认或限制直连 UDP');
  if (!isAutomaticTimezone(profile.timezone)) {
    try { new Intl.DateTimeFormat('en', { timeZone: profile.timezone }).format(); } catch { bad('无效的 IANA 时区'); }
  }
  if (profile.locale !== 'auto') {
    try { if (!Intl.getCanonicalLocales(profile.locale).length) bad('语言不能为空'); } catch { bad('无效的语言代码'); }
  }
  const { width, height } = profile.viewport || {};
  if (![width, height].every(n => Number.isInteger(n) && n >= 320 && n <= 7680)) bad('窗口尺寸必须在 320–7680 之间');
  if (!Number.isFinite(profile.deviceScaleFactor) || profile.deviceScaleFactor < 0.5 || profile.deviceScaleFactor > 4) bad('缩放比例必须为 0.5–4 之间的数字');
  if (![null, 'light', 'dark', 'no-preference'].includes(profile.colorScheme)) bad('无效的外观设置');
  if (profile.reducedMotion != null && !['reduce', 'no-preference'].includes(profile.reducedMotion)) bad('无效的动画偏好');
  if (profile.contrast != null && !['more', 'no-preference'].includes(profile.contrast)) bad('无效的对比度偏好');
  if (profile.forcedColors != null && !['active', 'none'].includes(profile.forcedColors)) bad('无效的强制配色设置');
  return emulatedDisplay(profile.display, profile.platform);
}
function buildContextOptions(profile) {
  const display = validateProfile(profile);
  const options = {
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    colorScheme: profile.colorScheme,
    reducedMotion: profile.reducedMotion,
    contrast: profile.contrast,
    forcedColors: profile.forcedColors,
    acceptDownloads: true,
    ignoreHTTPSErrors: false,
    bypassCSP: false,
    ...display,
  };
  if (profile.locale !== 'auto') options.locale = profile.locale;
  if (!isAutomaticTimezone(profile.timezone)) options.timezoneId = profile.timezone;
  if (profile.proxy) options.proxy = profile.proxy;
  return { options, display };
}
function webrtcArgs(profile) {
  // Proxy profiles always restrict UDP, even if a stale record says default.
  // This is Chromium's native IP handling policy, not a fake PeerConnection.
  return profile.proxy || profile.webrtc === 'restricted' ? [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
  ] : [];
}
module.exports = { HOST_PLATFORM, validateProfile, buildContextOptions, webrtcArgs };
