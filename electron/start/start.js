'use strict';
const config = window.cikeEnvironment;
const text = (id, value) => { document.getElementById(id).textContent = value || '未知'; };
text('name', config.name); text('number', '#' + config.sequence);
document.title = `#${config.sequence} ${config.name} · 环境检测`;
text('route', config.proxy ? '代理连接' : '系统网络');
text('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone); text('language', navigator.language);
function canonicalTimezone(timeZone) {
  try { return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone; }
  catch { return timeZone; }
}
async function getJSON(url) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('检测服务暂时不可用');
  return response.json();
}
async function detect() {
  const button = document.getElementById('refresh'); button.disabled = true;
  text('ip', '检测中…'); text('status', '通过当前环境的网络连接检测');
  for (const id of ['region', 'exit-timezone', 'isp']) text(id, '等待检测');
  document.getElementById('match').textContent = '';
  try {
    const { ip } = await getJSON('https://api.ipify.org?format=json');
    if (typeof ip !== 'string' || !/^[0-9a-fA-F.:]{3,45}$/.test(ip)) throw new Error('IP 检测响应无效');
    text('ip', ip); text('status', '检测成功 · ' + new Date().toLocaleTimeString());
    if (config.expectedIp && config.expectedIp !== ip) text('match', `当前出口与启动前检测的 ${config.expectedIp} 不同，请检查代理是否使用动态出口。`);
    await fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) });
    try {
      const geo = await getJSON('https://ipwho.is/' + encodeURIComponent(ip));
      if (geo.success === false || geo.ip !== ip) throw new Error('地区未知');
      text('region', [geo.country, geo.region, geo.city].filter(Boolean).join(' · '));
      text('exit-timezone', geo.timezone?.id); text('isp', geo.connection?.isp);
      if (geo.timezone?.id && canonicalTimezone(geo.timezone.id) !== canonicalTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)) {
        text('match', '浏览器时区与出口地区时区不同，请检查环境时区设置。地区数据库可能存在误差。');
      }
    } catch { for (const id of ['region', 'exit-timezone', 'isp']) text(id, '地区服务暂不可用'); }
  } catch { text('ip', '检测失败'); text('status', '请检查网络或代理后重新检测；不会切换为直连。'); }
  finally { button.disabled = false; }
}
document.getElementById('refresh').onclick = detect;
detect();

const valuesPanel = document.getElementById('browser-values');
function refreshDisplay() {
  text('readout-display', `${screen.width}×${screen.height} / ${innerWidth}×${innerHeight} / ${devicePixelRatio}`);
}

function graphicsReadout() {
  const canvas = document.createElement('canvas');
  const webgl2 = canvas.getContext('webgl2');
  const gl = webgl2 || canvas.getContext('webgl');
  const extension = gl?.getExtension('WEBGL_debug_renderer_info');
  const renderer = gl ? gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) : null;
  const webgl = renderer ? `${webgl2 ? 'WebGL 2' : 'WebGL'} · ${renderer}` : 'WebGL 不可用';
  return `${webgl} / WebGPU ${navigator.gpu ? '接口可用' : '接口不可用'}`;
}

function supportedCodecs() {
  const media = document.createElement('video');
  const formats = [
    ['H.264', 'video/mp4; codecs="avc1.42E01E"'],
    ['HEVC', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
    ['VP8', 'video/webm; codecs="vp8"'],
    ['VP9', 'video/webm; codecs="vp9"'],
    ['AV1', 'video/mp4; codecs="av01.0.04M.08"'],
    ['AAC', 'audio/mp4; codecs="mp4a.40.2"'],
    ['MP3', 'audio/mpeg'],
    ['FLAC', 'audio/flac'],
    ['Opus', 'audio/webm; codecs="opus"'],
  ];
  return formats.filter(([, type]) => media.canPlayType(type)).map(([name]) => name).join('、') || '未报告样本格式';
}

async function readFonts() {
  const samples = ['Arial', 'Calibri', 'Segoe UI', 'Segoe UI Variable', 'Microsoft YaHei', 'Yu Gothic', 'Malgun Gothic',
    'Helvetica Neue', 'PingFang SC', 'Noto Sans'];
  const names = await Promise.all(samples.map(async name => {
    try {
      await new FontFace('cike-font-sample', `local("${name}")`).load();
      return name;
    } catch { return null; }
  }));
  text('readout-fonts', names.filter(Boolean).join('、') || '未检测到样本字体');
}

async function readLocationPermission() {
  try {
    const { state } = await navigator.permissions.query({ name: 'geolocation' });
    text('readout-location', { granted: '允许', prompt: '使用时询问', denied: '已拒绝' }[state]);
  } catch { text('readout-location', '权限状态不可用'); }
}

valuesPanel.addEventListener('toggle', () => {
  if (!valuesPanel.open) return;
  refreshDisplay();
  text('readout-ua', navigator.userAgent);
  text('readout-languages', navigator.languages.join('、'));
  const memory = navigator.deviceMemory;
  text('readout-hardware', `${navigator.hardwareConcurrency ?? '未知'} / ${memory == null ? '接口不可用' : `${memory} GiB`}`);
  const mode = matchMedia('(prefers-color-scheme: dark)').matches ? '深色' : '浅色';
  const motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? '减少动画' : '无偏好';
  const colors = matchMedia('(forced-colors: active)').matches ? '启用' : '未启用';
  text('readout-appearance', `${mode} / ${motion} / ${colors}`);
  text('readout-graphics', graphicsReadout());
  text('readout-codecs', supportedCodecs());
  const connection = navigator.connection;
  text('readout-network', connection ? `${connection.effectiveType} · ${connection.downlink} Mbps · ${connection.rtt} ms` : '接口不可用');
  void readFonts();
  void readLocationPermission();
});
window.addEventListener('resize', () => { if (valuesPanel.open) refreshDisplay(); });
