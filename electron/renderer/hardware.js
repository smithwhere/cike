'use strict';
const AUTOMATIC_REGION = '代理地区 / 无代理时跟随系统';
const COLOR_SCHEMES = { light: '浅色', dark: '深色', system: '跟随系统', 'no-preference': '无偏好（兼容）' };
const MOTION_PREFERENCES = { 'no-preference': '无偏好', reduce: '减少动画', system: '跟随系统' };
let hardwareOptionsPromise;
async function mountHardware(root, prefix, profile = {}) {
  if (!hardwareOptionsPromise) hardwareOptionsPromise = api('/api/fingerprints/options');
  const options = await hardwareOptionsPromise;
  if (!root.isConnected) return;
  const kernel = profile.fingerprintMode === 'kernel', hardware = profile.fingerprintMode === 'hardware', simulated = kernel || hardware;
  const choices = (values, selected, label = String) => values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label(value))}</option>`).join('');
  const locales = [...new Set(['auto', ...options.locales, profile.locale || 'auto'])];
  const timezones = [...new Set(['auto', ...options.timezones, profile.timezone || 'auto'])];
  const regionLabel = value => value === 'auto' ? AUTOMATIC_REGION : value;
  const color = profile.colorScheme === null ? 'system' : profile.colorScheme ?? 'light';
  const motion = profile.reducedMotion === null ? 'system' : profile.reducedMotion ?? 'no-preference';
  const displays = options.displays;
  root.innerHTML = `
    <div class="field-row">
      <div class="field"><label for="${prefix}-locale">语言</label><select id="${prefix}-locale" class="input">${choices(locales, profile.locale || 'auto', regionLabel)}</select></div>
      <div class="field"><label for="${prefix}-tz">时区</label><select id="${prefix}-tz" class="input">${choices(timezones, profile.timezone || 'auto', regionLabel)}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="${prefix}-color-scheme">网页外观</label><select id="${prefix}-color-scheme" class="input">${choices(Object.keys(COLOR_SCHEMES), color, value => COLOR_SCHEMES[value])}</select></div>
      <div class="field"><label for="${prefix}-reduced-motion">网页动画偏好</label><select id="${prefix}-reduced-motion" class="input">${choices(Object.keys(MOTION_PREFERENCES), motion, value => MOTION_PREFERENCES[value])}</select></div>
    </div>
    <div class="field"><label>指纹策略</label><select id="${prefix}-fingerprint-mode" class="input"><option value="native" ${simulated ? '' : 'selected'}>原生一致（Chromium）</option><option value="kernel" ${kernel ? 'selected' : ''}>内核模拟（Camoufox / Firefox）</option><option value="hardware" ${hardware ? 'selected' : ''}>硬件模拟（软件层，可被检测）</option></select></div>
    ${displays ? `<div class="field-row">
      <div class="field"><label for="${prefix}-display-preset">显示测试预设</label><select id="${prefix}-display-preset" class="input" aria-describedby="${prefix}-display-summary">
        <option value="">跟随系统</option>
        ${displays.presets.map(({ id, name, width, height }) => `<option value="${esc(id)}" ${id === profile.display?.preset ? 'selected' : ''}>${width}×${height} · ${esc(name)}</option>`).join('')}
      </select></div>
      <div class="field"><label for="${prefix}-display-scale">测试缩放</label><select id="${prefix}-display-scale" class="input">${choices(displays.scales, profile.display?.scale ?? 100, scale => `${scale}%`)}</select></div>
    </div><p id="${prefix}-display-summary" class="hint" aria-live="polite"></p>` : ''}
    <div id="${prefix}-hardware-fields" class="${simulated ? '' : 'hidden'}">
      <div class="field-row"><div class="field"><label>CPU 线程数</label><select id="${prefix}-hardware-cpu" class="input">${choices(options.cpus, profile.hardwareConcurrency || 8)}</select></div>
      <div id="${prefix}-software-memory" class="field ${kernel ? 'hidden' : ''}"><label>网页内存值（GB）</label><select id="${prefix}-hardware-memory" class="input">${choices(options.memories, profile.deviceMemory || 8, value => value >= 48 ? `${value}（测试值）` : value)}</select></div></div>
      <div class="field"><label>显卡标识</label><select id="${prefix}-hardware-gpu" class="input">${options.gpus.map(gpu => `<option value="${esc(gpu.id)}" ${gpu.id === (profile.gpuPreset || 'native') ? 'selected' : ''}>${esc(gpu.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="${prefix}-user-agent">User-Agent</label><select id="${prefix}-user-agent" class="input"></select></div>
      <div id="${prefix}-software-noise" class="field-row ${kernel ? 'hidden' : ''}"><div class="field"><label>Canvas 读取</label><select id="${prefix}-hardware-canvas" class="input"><option value="yes" ${!hardware || profile.canvasNoise ? 'selected' : ''}>按环境固定处理</option><option value="no" ${hardware && !profile.canvasNoise ? 'selected' : ''}>原生输出</option></select></div>
      <div class="field"><label>音频读取</label><select id="${prefix}-hardware-audio" class="input"><option value="yes" ${!hardware || profile.audioNoise ? 'selected' : ''}>按环境固定处理</option><option value="no" ${hardware && !profile.audioNoise ? 'selected' : ''}>原生输出</option></select></div></div>
      <input type="hidden" id="${prefix}-fingerprint-seed" value="${esc(profile.fingerprintSeed || '')}">
      <div class="row"><span id="${prefix}-hardware-id" class="hint">${profile.fingerprintSeed ? '配置编号 ' + esc(profile.fingerprintSeed.slice(0, 8)) : '保存时生成固定配置编号'}</span><button type="button" id="${prefix}-hardware-generate" class="btn small">生成另一组</button></div>
      <p class="hint">保存后重开环境生效。重新生成会更换配置，相同参数不保证得到不同指纹；显卡标识不改变实际渲染能力。</p>
    </div>
    <p id="${prefix}-kernel-hint" class="hint ${kernel ? '' : 'hidden'}">内核模式在 Firefox 内部设置 CPU/显卡，页面与 Worker 共用配置，不注入页面脚本。Canvas/音频保持原生，Firefox 原本不提供 deviceMemory。建议显卡保持原生；更改标识不能改变实际 GPU 能力。先在“设置”下载 Camoufox（约 1.3 GB）。Chrome 与 Firefox 的 Cookie/站点数据独立保存，切换后需要重新登录；原 Chrome 数据保留，可切回。配置编号不是网站读取的完整指纹。</p>
    <p id="${prefix}-software-hint" class="hint ${hardware ? '' : 'hidden'}">软件层模式会改写浏览器 API，并可处理 Canvas/音频输出。即使参数一致，检测网站仍可能报告“环境被篡改”。如需避免这些脚本改写痕迹，请使用内核模式；不保证通过所有网站检测。</p>`;
  const field = id => root.querySelector('#' + prefix + '-' + id);
  if (displays) {
    const preset = field('display-preset'), scale = field('display-scale');
    const syncDisplay = () => {
      const selected = displays.presets.find(item => item.id === preset.value);
      scale.disabled = !selected;
      const summary = field('display-summary');
      if (!selected) { summary.textContent = ''; return; }
      const ratio = Number(scale.value) / 100;
      const width = Math.floor(selected.width / ratio), height = Math.floor(selected.height / ratio);
      const reference = selected.specs ? `硬件参考 ${selected.specs}。` : '';
      summary.textContent = `CSS 屏幕与视口 ${width}×${height}，DPR ${ratio}。测试窗口使用固定视口。${reference}`;
    };
    preset.onchange = scale.onchange = syncDisplay;
    syncDisplay();
  }
  const userAgent = field('user-agent');
  const selectedUserAgents = { [profile.fingerprintMode]: profile.userAgent || '' };
  const syncMode = () => {
    const mode = field('fingerprint-mode').value;
    field('hardware-fields').classList.toggle('hidden', mode === 'native');
    for (const id of ['software-memory', 'software-noise', 'software-hint']) field(id).classList.toggle('hidden', mode !== 'hardware');
    field('kernel-hint').classList.toggle('hidden', mode !== 'kernel');
    const presets = options.userAgents?.[mode] || [];
    userAgent.replaceChildren(new Option('内核原生 UA', ''));
    if (presets.length) {
      userAgent.add(new Option('在默认内核同主版本中随机分配', 'random'));
      for (const [label, value] of presets) userAgent.add(new Option(`${label}（测试预设）`, value));
      userAgent.value = selectedUserAgents[mode] ?? '';
    }
  };
  userAgent.onchange = () => { selectedUserAgents[field('fingerprint-mode').value] = userAgent.value; };
  field('fingerprint-mode').onchange = syncMode;
  syncMode();
  field('hardware-generate').onclick = async event => {
    event.target.disabled = true;
    try {
      const { fingerprint } = await api('/api/fingerprints/generate', { method: 'POST', body: '{}' });
      if (!root.isConnected) return;
      const mode = field('fingerprint-mode').value === 'hardware' ? 'hardware' : 'kernel';
      field('fingerprint-mode').value = mode; syncMode();
      field('hardware-cpu').value = fingerprint.hardwareConcurrency;
      field('hardware-memory').value = fingerprint.deviceMemory;
      field('hardware-gpu').value = mode === 'kernel' ? 'native' : fingerprint.gpuPreset;
      field('hardware-canvas').value = field('hardware-audio').value = 'yes';
      field('fingerprint-seed').value = fingerprint.fingerprintSeed;
      field('hardware-id').textContent = '配置编号 ' + fingerprint.fingerprintSeed.slice(0, 8);
    } catch (error) { toast(error.message, true); }
    finally { event.target.disabled = false; }
  };
}
function readHardware(root, prefix, fallback = {}) {
  const field = id => root.querySelector('#' + prefix + '-' + id);
  const mode = field('fingerprint-mode')?.value || (['hardware', 'kernel'].includes(fallback.fingerprintMode) ? fallback.fingerprintMode : 'native');
  const userAgentField = field('user-agent');
  const userAgent = userAgentField ? userAgentField.value || null : fallback.userAgent ?? null;
  const preset = field('display-preset');
  const display = preset ? (preset.value ? { preset: preset.value, scale: Number(field('display-scale').value) } : null) : fallback.display ?? null;
  const color = field('color-scheme')?.value ?? (fallback.colorScheme === null ? 'system' : fallback.colorScheme ?? 'light');
  const motion = field('reduced-motion')?.value ?? (fallback.reducedMotion === null ? 'system' : fallback.reducedMotion ?? 'no-preference');
  const common = {
    display,
    locale: field('locale')?.value ?? fallback.locale ?? 'auto',
    timezone: field('tz')?.value ?? fallback.timezone ?? 'auto',
    colorScheme: color === 'system' ? null : color,
    reducedMotion: motion === 'system' ? null : motion,
  };
  if (mode === 'native') return { ...common, fingerprintMode: 'native', userAgent: null, hardwareConcurrency: null, deviceMemory: null, gpuPreset: 'native', canvasNoise: false, audioNoise: false, fingerprintSeed: fallback.fingerprintSeed || null };
  if (mode === 'kernel') return { ...common, fingerprintMode: 'kernel', hardwareConcurrency: Number(field('hardware-cpu')?.value || fallback.hardwareConcurrency || 8),
    userAgent, deviceMemory: null, gpuPreset: field('hardware-gpu')?.value || fallback.gpuPreset || 'native', canvasNoise: false, audioNoise: false,
    fingerprintSeed: field('fingerprint-seed')?.value || fallback.fingerprintSeed || null };
  return { ...common, fingerprintMode: 'hardware', userAgent, hardwareConcurrency: Number(field('hardware-cpu')?.value || fallback.hardwareConcurrency),
    deviceMemory: Number(field('hardware-memory')?.value || fallback.deviceMemory), gpuPreset: field('hardware-gpu')?.value || fallback.gpuPreset,
    canvasNoise: field('hardware-canvas') ? field('hardware-canvas').value === 'yes' : fallback.canvasNoise,
    audioNoise: field('hardware-audio') ? field('hardware-audio').value === 'yes' : fallback.audioNoise,
    fingerprintSeed: field('fingerprint-seed')?.value || fallback.fingerprintSeed || null };
}
