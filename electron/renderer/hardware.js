'use strict';
const AUTOMATIC_TIMEZONE = '代理地区 / 无代理时跟随系统';
const IP_TIMEZONE = '跟随出口 IP（启动时查询）';
const COLOR_SCHEMES = { light: '浅色', dark: '深色', system: '跟随系统', 'no-preference': '无偏好（兼容）' };
const MOTION_PREFERENCES = { 'no-preference': '无偏好', reduce: '减少动画', system: '跟随系统' };
const CONTRAST_PREFERENCES = { 'no-preference': '无偏好', more: '更高对比度', system: '跟随系统' };
const FORCED_COLORS = { none: '关闭', active: '启用强制配色', system: '跟随系统' };
const mediaValue = (value, defaultValue) => value === null ? 'system' : value ?? defaultValue;
let hardwareOptionsPromise;
function loadHardwareForm(root, prefix, profile, saveButtons) {
  const load = async () => {
    for (const button of saveButtons) button.disabled = true;
    root.innerHTML = '<p class="hint" role="status">正在加载指纹选项…</p>';
    try {
      await mountHardware(root, prefix, profile);
      if (root.isConnected) for (const button of saveButtons) button.disabled = false;
    } catch {
      if (!root.isConnected) return;
      root.innerHTML = '<p class="hint" role="status">指纹选项加载失败，请重试后保存。</p><button type="button" class="btn small">重新加载</button>';
      root.querySelector('button').onclick = load;
    }
  };
  void load();
}

async function mountHardware(root, prefix, profile = {}) {
  hardwareOptionsPromise ??= api('/api/fingerprints/options').catch(error => {
    hardwareOptionsPromise = undefined;
    throw error;
  });
  const options = await hardwareOptionsPromise;
  if (!root.isConnected) return;
  const creating = !profile.id;
  const kernel = profile.fingerprintMode === 'kernel', hardware = profile.fingerprintMode === 'hardware', simulated = kernel || hardware;
  const choices = (values, selected, label = String) => values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label(value))}</option>`).join('');
  const locales = [...new Set(['auto', ...options.locales, profile.locale || 'auto'])];
  const selectedTimezone = profile.timezone || (creating ? 'ip' : 'auto');
  const timezones = [...new Set(['ip', 'auto', ...options.timezones, selectedTimezone])];
  const displays = options.displays;
  root.innerHTML = `
    <div class="field"><label for="${prefix}-fingerprint-mode">指纹策略</label><select id="${prefix}-fingerprint-mode" class="input">${creating ? '<option value="random" selected>每次创建随机生成（Chromium）</option>' : ''}<option value="native" ${!creating && !simulated ? 'selected' : ''}>原生一致（Chromium）</option><option value="kernel" ${kernel ? 'selected' : ''}>内核模拟（Camoufox / Firefox）</option><option value="hardware" ${hardware ? 'selected' : ''}>硬件模拟（软件层，可被检测）</option></select></div>
    ${creating ? `<p id="${prefix}-random-hint" class="hint">创建时抽取 CPU、内存、可用的 UA 和显卡预设、窗口尺寸与缩放和网页偏好，并生成 Canvas 种子。语言和时区在打开时按出口 IP 选择。音频、插件和字体使用原生读数。</p>` : ''}
    <div id="${prefix}-preferences">
    <div class="field-row">
      <div class="field"><label for="${prefix}-locale">备用语言</label><select id="${prefix}-locale" class="input">${choices(locales, profile.locale || 'auto', value => value === 'auto' ? '自动' : value)}</select></div>
      <div class="field"><label for="${prefix}-tz">时区</label><select id="${prefix}-tz" class="input">${choices(timezones, selectedTimezone, value => value === 'ip' ? IP_TIMEZONE : value === 'auto' ? AUTOMATIC_TIMEZONE : value)}</select></div>
    </div>
    <p class="hint">环境打开时按出口 IP 选择语言。地区无法识别时才使用备用语言。</p>
    <div class="field-row">
      <div class="field"><label for="${prefix}-color-scheme">网页外观</label><select id="${prefix}-color-scheme" class="input">${choices(Object.keys(COLOR_SCHEMES), mediaValue(profile.colorScheme, 'light'), value => COLOR_SCHEMES[value])}</select></div>
      <div class="field"><label for="${prefix}-reduced-motion">网页动画偏好</label><select id="${prefix}-reduced-motion" class="input">${choices(Object.keys(MOTION_PREFERENCES), mediaValue(profile.reducedMotion, 'no-preference'), value => MOTION_PREFERENCES[value])}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="${prefix}-contrast">网页对比度偏好</label><select id="${prefix}-contrast" class="input">${choices(Object.keys(CONTRAST_PREFERENCES), mediaValue(profile.contrast, 'no-preference'), value => CONTRAST_PREFERENCES[value])}</select></div>
      <div class="field"><label for="${prefix}-forced-colors">网页强制配色</label><select id="${prefix}-forced-colors" class="input">${choices(Object.keys(FORCED_COLORS), mediaValue(profile.forcedColors, 'none'), value => FORCED_COLORS[value])}</select></div>
    </div>
    </div>
    ${displays ? `<div id="${prefix}-display-fields"><div class="field-row">
      <div class="field"><label for="${prefix}-display-preset">显示测试预设</label><select id="${prefix}-display-preset" class="input" aria-describedby="${prefix}-display-summary">
        <option value="">跟随系统</option>
        ${displays.presets.map(({ id, name, width, height }) => `<option value="${esc(id)}" ${id === profile.display?.preset ? 'selected' : ''}>${width}×${height} · ${esc(name)}</option>`).join('')}
      </select></div>
      <div class="field"><label for="${prefix}-display-scale">测试缩放</label><select id="${prefix}-display-scale" class="input"></select></div>
    </div><p id="${prefix}-display-summary" class="hint" aria-live="polite"></p></div>` : ''}
    <div id="${prefix}-hardware-fields" class="${simulated ? '' : 'hidden'}">
      <div class="field-row"><div class="field"><label>CPU 线程数</label><select id="${prefix}-hardware-cpu" class="input">${choices(options.cpus, profile.hardwareConcurrency || 8)}</select></div>
      <div id="${prefix}-software-memory" class="field ${kernel ? 'hidden' : ''}"><label for="${prefix}-hardware-memory">网页内存（GiB）</label><select id="${prefix}-hardware-memory" class="input">
        <option value="">内核原生</option>
        <optgroup label="桌面分档 · 仅测试网页读数">${choices(options.desktopMemories, profile.deviceMemory)}</optgroup>
        <optgroup label="兼容性测试 · 非当前桌面分档">${choices(options.testMemories, profile.deviceMemory)}</optgroup>
      </select></div></div>
      <div class="field"><label for="${prefix}-hardware-gpu">显卡标识</label><select id="${prefix}-hardware-gpu" class="input"></select></div>
      <div class="field"><label for="${prefix}-user-agent">User-Agent</label><select id="${prefix}-user-agent" class="input"></select></div>
      <div id="${prefix}-software-noise" class="field ${kernel ? 'hidden' : ''}"><label for="${prefix}-hardware-canvas">Canvas 读取</label><select id="${prefix}-hardware-canvas" class="input"><option value="yes" ${!hardware || profile.canvasNoise ? 'selected' : ''}>按环境固定处理</option><option value="no" ${hardware && !profile.canvasNoise ? 'selected' : ''}>原生输出</option></select></div>
      <div id="${prefix}-kernel-canvas-field" class="field ${kernel ? '' : 'hidden'}">
        <label><input type="checkbox" id="${prefix}-kernel-canvas" ${profile.canvasSiteProtection ? 'checked' : ''}> 按站点保护 Canvas 读取</label>
      </div>
      <input type="hidden" id="${prefix}-fingerprint-seed" value="${esc(profile.fingerprintSeed || '')}">
      <div class="row"><span id="${prefix}-hardware-id" class="hint">${profile.fingerprintSeed ? '配置编号 ' + esc(profile.fingerprintSeed.slice(0, 8)) : '保存时生成固定配置编号'}</span><button type="button" id="${prefix}-hardware-generate" class="btn small">生成另一组</button></div>
      <p class="hint">保存后重开环境生效。重新生成会更换配置，相同参数不保证得到不同指纹；显卡标识不改变实际渲染能力。</p>
    </div>
    <p id="${prefix}-kernel-hint" class="hint ${kernel ? '' : 'hidden'}">内核模式在 Firefox 内部设置 CPU 线程数。Canvas 可启用 Firefox 的站点保护，显卡和音频使用内核输出。先在“设置”下载 Camoufox（约 1.3 GB）。Chrome 与 Firefox 的 Cookie/站点数据独立保存，切换后需要重新登录；原 Chrome 数据保留，可切回。配置编号不是网站读取的完整指纹。</p>
    <p id="${prefix}-software-hint" class="hint ${hardware ? '' : 'hidden'}">软件层用于兼容性测试。手动内存值仅影响 JavaScript 读数，网络请求头由内核协商。音频保留原生输出。</p>`;
  const field = id => root.querySelector('#' + prefix + '-' + id);
  if (displays) {
    const preset = field('display-preset'), scale = field('display-scale');
    const syncDisplay = requestedScale => {
      const selected = displays.presets.find(item => item.id === preset.value);
      const scales = selected?.scales ?? displays.scales;
      const activeScale = scales.includes(requestedScale) ? requestedScale : scales.at(-1);
      scale.innerHTML = choices(scales, activeScale, value => `${value}%`);
      scale.disabled = !selected;
      const summary = field('display-summary');
      if (!selected) { summary.textContent = ''; return; }
      const ratio = activeScale / 100;
      const width = Math.floor(selected.width / ratio), height = Math.floor(selected.height / ratio);
      const reference = selected.specs ? `硬件参考 ${selected.specs}。` : '';
      summary.textContent = `设定的 CSS 屏幕与视口 ${width}×${height}，DPR ${ratio}。窗口放不下时，打开会自动提高到可完整显示的最低缩放档。${reference}`;
    };
    preset.onchange = scale.onchange = () => syncDisplay(Number(scale.value));
    syncDisplay(profile.display?.scale ?? 100);
  }
  const userAgent = field('user-agent'), gpu = field('hardware-gpu');
  const viewportField = document.getElementById(`${prefix}-viewport-field`);
  const selectedGpus = { [profile.fingerprintMode]: profile.gpuPreset };
  const selectedUserAgents = { [profile.fingerprintMode]: profile.userAgent || '' };
  const syncMode = () => {
    const mode = field('fingerprint-mode').value;
    const random = mode === 'random';
    field('hardware-fields').classList.toggle('hidden', mode !== 'hardware' && mode !== 'kernel');
    if (creating) field('random-hint').classList.toggle('hidden', !random);
    if (displays) field('display-fields').classList.toggle('hidden', random);
    field('preferences').classList.toggle('hidden', random);
    viewportField?.classList.toggle('hidden', random);
    for (const id of ['software-memory', 'software-noise', 'software-hint']) field(id).classList.toggle('hidden', mode !== 'hardware');
    field('kernel-canvas-field').classList.toggle('hidden', mode !== 'kernel');
    field('kernel-hint').classList.toggle('hidden', mode !== 'kernel');
    const allowedGpus = mode === 'hardware' ? options.gpus : [{ id: 'native', name: '原生显卡' }];
    gpu.replaceChildren(...allowedGpus.map(({ id, name }) => new Option(name, id)));
    gpu.value = allowedGpus.some(({ id }) => id === selectedGpus[mode]) ? selectedGpus[mode] : 'native';
    const selectable = options.selectableUserAgents?.[mode];
    const presets = (options.userAgents?.[mode] || []).filter(([, value]) =>
      !selectable || selectable.includes(value) || (mode === profile.fingerprintMode && value === profile.userAgent));
    const current = new Set(options.currentUserAgents?.[mode]);
    userAgent.replaceChildren(new Option('内核原生 UA', ''));
    if (presets.length) userAgent.add(new Option('从可选 UA 预设随机', 'random-preset'));
    for (const [label, matches] of [['当前主版本测试', true], ['其他版本兼容性测试', false]]) {
      const entries = presets.filter(([, value]) => current.has(value) === matches);
      if (!entries.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const [name, value] of entries) group.append(new Option(name, value));
      userAgent.add(group);
    }
    const selectedAgent = selectedUserAgents[mode];
    userAgent.value = [...userAgent.options].some(option => option.value === selectedAgent) ? selectedAgent : '';
  };
  userAgent.onchange = () => { selectedUserAgents[field('fingerprint-mode').value] = userAgent.value; };
  gpu.onchange = () => { selectedGpus[field('fingerprint-mode').value] = gpu.value; };
  field('fingerprint-mode').onchange = syncMode;
  syncMode();
  field('hardware-generate').onclick = async event => {
    const mode = field('fingerprint-mode').value;
    event.target.disabled = true;
    try {
      const { fingerprint } = await api('/api/fingerprints/generate', { method: 'POST', body: '{}' });
      if (!root.isConnected || field('fingerprint-mode').value !== mode) return;
      field('hardware-cpu').value = fingerprint.hardwareConcurrency;
      gpu.value = mode === 'kernel' ? 'native' : fingerprint.gpuPreset;
      gpu.onchange();
      field('hardware-canvas').value = 'yes';
      field('fingerprint-seed').value = fingerprint.fingerprintSeed;
      field('hardware-id').textContent = '配置编号 ' + fingerprint.fingerprintSeed.slice(0, 8);
    } catch (error) { toast(error.message, true); }
    finally { event.target.disabled = false; }
  };
}
function readHardware(root, prefix, fallback = {}) {
  const field = id => root.querySelector('#' + prefix + '-' + id);
  const mode = field('fingerprint-mode')?.value || (['hardware', 'kernel'].includes(fallback.fingerprintMode) ? fallback.fingerprintMode : 'native');
  if (mode === 'random') return { fingerprintMode: mode };
  const userAgentField = field('user-agent');
  const userAgent = userAgentField ? userAgentField.value || null : fallback.userAgent ?? null;
  const preset = field('display-preset');
  const display = preset ? (preset.value ? { preset: preset.value, scale: Number(field('display-scale').value) } : null) : fallback.display ?? null;
  const readMedia = (id, key, defaultValue) => {
    const value = field(id)?.value ?? mediaValue(fallback[key], defaultValue);
    return value === 'system' ? null : value;
  };
  const common = {
    display,
    locale: field('locale')?.value ?? fallback.locale ?? 'auto',
    timezone: field('tz')?.value ?? fallback.timezone ?? 'auto',
    colorScheme: readMedia('color-scheme', 'colorScheme', 'light'),
    reducedMotion: readMedia('reduced-motion', 'reducedMotion', 'no-preference'),
    contrast: readMedia('contrast', 'contrast', 'no-preference'),
    forcedColors: readMedia('forced-colors', 'forcedColors', 'none'),
  };
  if (mode === 'native') return { ...common, fingerprintMode: 'native', userAgent: null, hardwareConcurrency: null, deviceMemory: null, gpuPreset: 'native', canvasNoise: false, audioNoise: false, fingerprintSeed: fallback.fingerprintSeed || null };
  if (mode === 'kernel') return { ...common, fingerprintMode: 'kernel',
    canvasSiteProtection: field('kernel-canvas')?.checked ?? fallback.canvasSiteProtection ?? false,
    hardwareConcurrency: Number(field('hardware-cpu')?.value || fallback.hardwareConcurrency || 8),
    userAgent, deviceMemory: null, gpuPreset: field('hardware-gpu')?.value || fallback.gpuPreset || 'native', canvasNoise: false, audioNoise: false,
    fingerprintSeed: field('fingerprint-seed')?.value || fallback.fingerprintSeed || null };
  const memory = field('hardware-memory')?.value ?? fallback.deviceMemory;
  return { ...common, fingerprintMode: 'hardware', userAgent, hardwareConcurrency: Number(field('hardware-cpu')?.value || fallback.hardwareConcurrency),
    deviceMemory: memory ? Number(memory) : null, gpuPreset: field('hardware-gpu')?.value || fallback.gpuPreset,
    canvasNoise: field('hardware-canvas') ? field('hardware-canvas').value === 'yes' : fallback.canvasNoise,
    audioNoise: false,
    fingerprintSeed: field('fingerprint-seed')?.value || fallback.fingerprintSeed || null };
}
