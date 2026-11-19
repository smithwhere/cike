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
async function submitCheck(path, data) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('检测记录未更新');
  return response.json();
}
function canonicalIp(ip) {
  if (typeof ip !== 'string') return null;
  if (!ip.includes(':')) return ip;
  try { return new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return null; }
}
async function detect() {
  const button = document.getElementById('refresh'); button.disabled = true;
  for (const id of ['ip', 'ip-v4', 'ip-v6']) text(id, '检测中…');
  text('status', '通过当前环境的网络连接检测');
  for (const id of ['region', 'exit-timezone', 'isp']) text(id, '等待检测');
  document.getElementById('match').textContent = '';
  try {
    const { id } = await submitCheck('/check', {});
    const probes = await Promise.allSettled([
      getJSON('https://api.ipify.org?format=json'), getJSON('https://api6.ipify.org?format=json'),
    ]);
    const { exitIp: ip, exitIPv4, exitIPv6 } = await submitCheck('/result', {
      id, exitIPv4: probes[0].value?.ip, exitIPv6: probes[1].value?.ip,
    });
    text('ip-v4', exitIPv4 || '未检测到'); text('ip-v6', exitIPv6 || '未检测到');
    if (!ip) throw new Error('未检测到出口');
    text('ip', ip); text('status', '检测成功 · ' + new Date().toLocaleTimeString());
    const notices = [];
    for (const [family, actual, expected] of [['IPv4', exitIPv4, config.expected.exitIPv4], ['IPv6', exitIPv6, config.expected.exitIPv6]]) {
      if (actual && expected && actual !== expected) notices.push(`${family} 出口与启动前检测的 ${expected} 不同，请检查代理是否使用动态出口。`);
    }
    try {
      const geo = await getJSON('https://ipwho.is/' + encodeURIComponent(ip));
      if (geo.success === false || canonicalIp(geo.ip) !== ip) throw new Error('地区未知');
      text('region', [geo.country, geo.region, geo.city].filter(Boolean).join(' · '));
      text('exit-timezone', geo.timezone?.id); text('isp', geo.connection?.isp);
      if (geo.timezone?.id && canonicalTimezone(geo.timezone.id) !== canonicalTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)) {
        notices.push('浏览器时区与出口地区时区不同，请检查环境时区设置。地区数据库可能存在误差。');
      }
    } catch { for (const id of ['region', 'exit-timezone', 'isp']) text(id, '地区服务暂不可用'); }
    document.getElementById('match').textContent = notices.join(' ');
  } catch {
    for (const id of ['ip-v4', 'ip-v6']) if (document.getElementById(id).textContent === '检测中…') text(id, '未检测到');
    text('ip', '检测失败'); text('status', '请检查网络或代理后重新检测；不会切换为直连。');
  }
  finally { button.disabled = false; }
}
document.getElementById('refresh').onclick = detect;

const valuesPanel = document.getElementById('browser-values');
function refreshDisplay() {
  text('readout-display', `${screen.width}×${screen.height} / ${screen.availWidth}×${screen.availHeight} / ${devicePixelRatio}`);
  const visual = visualViewport ? ` / ${visualViewport.scale.toFixed(2)}×` : '';
  text('readout-viewport', `${outerWidth}×${outerHeight} / ${innerWidth}×${innerHeight}${visual}`);
  const rects = Array.from(document.getElementById('rect-fixture').getClientRects(), ({ width, height }) =>
    `${width.toFixed(2)}×${height.toFixed(2)}`);
  text('readout-rects', rects.length ? `${rects.join(' / ')} CSS px` : '样本不可用');
}

function graphicsReadout() {
  const canvas = document.createElement('canvas');
  const webgl2 = canvas.getContext('webgl2'), gl = webgl2 || canvas.getContext('webgl');
  if (!gl) return 'WebGL 不可用';
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
  const capabilities = `最大纹理 ${gl.getParameter(gl.MAX_TEXTURE_SIZE)} · ${gl.getSupportedExtensions()?.length ?? 0} 项扩展`;
  const version = webgl2 ? 'WebGL 2' : 'WebGL';
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return `${version} · ${renderer} · ${capabilities}`;
}

async function readWebGpu() {
  try {
    if (!navigator.gpu) return text('readout-webgpu', '接口不可用');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return text('readout-webgpu', '未获得适配器');
    const { vendor, description } = adapter.info ?? {};
    const name = description || vendor || '适配器未报告标识';
    text('readout-webgpu', `${name} · 最大二维纹理 ${adapter.limits.maxTextureDimension2D} · ${adapter.features.size} 项功能`);
  } catch { text('readout-webgpu', '适配器读取失败'); }
}

async function readClientHints() {
  const base = [config.browserVersion || '内核未报告版本', navigator.platform || '平台未报告'];
  const data = navigator.userAgentData;
  if (!data) return text('readout-client', [...base, 'Client Hints 接口不可用'].join(' · '));
  const brands = entries => entries.map(({ brand, version }) => `${brand} ${version}`).join('、');
  const low = [data.platform, brands(data.brands)].filter(Boolean);
  text('readout-client', [...base, ...low].join(' · '));
  try {
    const { architecture, bitness, fullVersionList } = await data.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList']);
    text('readout-client', [...base, ...low, architecture, bitness && `${bitness} 位`,
      fullVersionList && brands(fullVersionList)].filter(Boolean).join(' · '));
  } catch { /* Keep the values already reported by the browser. */ }
}

async function sampleDigest(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest, 0, 8), value => value.toString(16).padStart(2, '0')).join('');
}

async function readCanvas() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 48;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 128, 48);
    gradient.addColorStop(0, '#78b4c8');
    gradient.addColorStop(1, '#30435f');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 48);
    context.font = '16px sans-serif';
    context.fillStyle = '#fff';
    context.fillText('CIKE 字形', 8, 30);
    context.fillStyle = 'rgba(80, 155, 205, 0.5)';
    context.fillRect(136, 8, 48, 32);
    const opaque = ctx => ctx.getImageData(0, 0, 128, 48).data;
    const digest = await sampleDigest(opaque(context));
    const repeated = await sampleDigest(opaque(context));
    const transparent = await sampleDigest(context.getImageData(128, 0, 64, 48).data);
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const bitmap = await createImageBitmap(png);
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const decoded = copy.getContext('2d');
    decoded.drawImage(bitmap, 0, 0);
    bitmap.close();
    const roundTrip = await sampleDigest(opaque(decoded));
    const comparison = value => value === digest ? '一致' : '有差异';
    text('readout-canvas', `${digest} · 半透明 ${transparent} · 重读${comparison(repeated)} · PNG${comparison(roundTrip)}`);
  } catch { text('readout-canvas', '样本不可用'); }
}

async function readAudio() {
  try {
    const context = new OfflineAudioContext(1, 4096, 44100);
    const oscillator = context.createOscillator();
    oscillator.connect(context.destination);
    oscillator.start();
    const buffer = await context.startRendering();
    const digest = await sampleDigest(buffer.getChannelData(0));
    const copy = new Float32Array(buffer.length);
    buffer.copyFromChannel(copy, 0);
    const readMatches = await sampleDigest(copy) === digest;
    text('readout-audio', `${buffer.sampleRate} Hz · ${digest} · 复制读取${readMatches ? '一致' : '有差异'}`);
  } catch { text('readout-audio', '样本不可用'); }
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
  const context = document.createElement('canvas').getContext('2d');
  if (context) {
    context.font = '16px sans-serif';
    const widths = ['中文字体', '日本語かな', '한글 글꼴'].map(value => context.measureText(value).width.toFixed(2));
    text('readout-cjk', `${widths.join(' / ')} CSS px`);
  }
  const samples = ['Arial', 'Calibri', 'Segoe UI', 'Segoe UI Variable', 'Microsoft YaHei', 'SimSun', 'Yu Gothic', 'Malgun Gothic',
    'Helvetica Neue', 'PingFang SC', 'Hiragino Sans', 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans CJK JP'];
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
  void readClientHints();
  text('readout-languages', navigator.languages.join('、'));
  const memory = navigator.deviceMemory;
  text('readout-hardware', `${navigator.hardwareConcurrency ?? '未知'} / ${memory == null ? '接口不可用' : `${memory} GiB`}`);
  const mode = matchMedia('(prefers-color-scheme: dark)').matches ? '深色' : '浅色';
  const motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? '减少动画' : '无偏好';
  const colors = matchMedia('(forced-colors: active)').matches ? '启用' : '未启用';
  const contrast = matchMedia('(prefers-contrast: more)').matches ? '更高对比度'
    : matchMedia('(prefers-contrast: less)').matches ? '更低对比度'
      : matchMedia('(prefers-contrast: custom)').matches ? '自定义对比度' : '默认对比度';
  text('readout-appearance', `${mode} / ${motion} / ${colors} / ${contrast}`);
  const policy = { native: '原生一致', kernel: '内核模拟', hardware: '硬件模拟（软件层）' }[config.mode] || '未知';
  const processing = enabled => enabled ? '固定处理' : '原生输出';
  text('readout-mode', `${policy} · Canvas ${processing(config.canvasProcessing)} · 音频 原生输出`);
  const drawing = { hardware: '硬件加速', software: '兼容软件绘制' }[config.graphicsMode] || '内核自动选择';
  text('readout-graphics-mode', `${config.gpuPreset} / ${drawing}`);
  text('readout-graphics', graphicsReadout());
  void readWebGpu();
  text('readout-plugins', Array.from(navigator.plugins ?? [], plugin => plugin.name).join('、') || '浏览器未报告插件');
  text('readout-pdf', typeof navigator.pdfViewerEnabled === 'boolean' ? (navigator.pdfViewerEnabled ? '可用' : '不可用') : '接口不可用');
  text('readout-webrtc', config.restrictWebRTC ? '限制直连 UDP' : '内核默认策略');
  text('readout-codecs', supportedCodecs());
  const connection = navigator.connection;
  text('readout-network', connection ? `${connection.effectiveType} · ${connection.downlink} Mbps · ${connection.rtt} ms` : '接口不可用');
  void readFonts();
  void readLocationPermission();
  void readCanvas();
  void readAudio();
});
window.addEventListener('resize', () => { if (valuesPanel.open) refreshDisplay(); });
window.visualViewport?.addEventListener('resize', () => { if (valuesPanel.open) refreshDisplay(); });
