'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { buildContextOptions, webrtcArgs, validateProfile } = require('./fingerprint');
const { resolveProxy } = require('./proxyconfig');
const { ProxyStore } = require('./proxystore');
const { checkProxy, checkDirectNetwork, prepareProxyRoute, openProxyTransport, exitAddresses } = require('./proxycheck');
const { localeForCountry, isAutomaticTimezone } = require('./localemap');
const { chromiumBrowsingSwitches } = require('./chromium-browsing');
const { DEFAULT_DNS_MODE, prepareChromiumDNS, selectFirefoxDNSMode } = require('./secure-dns');
const { privateDirectory } = require('./privatefiles');
const { prepareDownloads, configureDownloads } = require('./downloads');
const { WindowStateManager } = require('./windowstate');
const { fitWindowsDisplay, fittedWindowsWindowPosition } = require('./display-presets');
const { launchWithGraphics } = require('./native-graphics');
const { within, stopContext, forceStopContext, ownedBrowser } = require('./browser-lifecycle');

function findFreePort(min, max) {
  return new Promise((resolve, reject) => {
    let port = min;
    const next = () => {
      if (port > max) return reject(new Error('no free debug port'));
      const s = net.createServer();
      s.once('error', () => { port++; next(); });
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
    };
    next();
  });
}
class BrowserManager {
  constructor(store, proxyStore = null, settings = null, options = {}) {
    this.store = store;
    this.proxyStore = proxyStore;
    this.settings = settings;
    this.downloadsDirectory = options.downloadsDirectory;
    this.checkProxy = options.checkProxy || checkProxy;
    this.checkDirectNetwork = options.checkDirectNetwork || checkDirectNetwork;
    this.resolveChromium = options.resolveChromium;
    this.getDisplayWorkArea = options.getDisplayWorkArea;
    this.sessions = new Map();
    this.opening = new Map();
    this.closing = new Map();
    this.cancelled = new Set();
    this.contexts = new Map();
    this.crashes = new Map();
    this.startPage = options.startPage !== false;
    this.profileIcons = options.profileIcons !== false;
    this.windowStates = new WindowStateManager(settings);
    this.windowTokens = new Map();
  }
  isOpen(id) { return this.sessions.has(id) || this.opening.has(id) || this.contexts.has(id); }
  windowWarning(id) {
    const session = this.sessions.get(id);
    if (!session?.windowControl) return null;
    if (session.windowControl.unavailable) return '窗口同步组件不可用，可手动调整窗口；浏览器继续运行';
    return this.windowTokens.get(session.windowControl.token)?.ready ? null : '窗口同步暂未连接，正在重试；可手动调整窗口';
  }
  listOpen() {
    return [...this.sessions].map(([id, s]) => ({ profile_id: id,
      ...(s.debugPort ? { debug_url: `http://127.0.0.1:${s.debugPort}` } : {}),
      headless: s.headless, opened_at: new Date(s.openedAt).toISOString(), network: s.network,
      ...(s.graphicsMode ? { graphicsMode: s.graphicsMode } : {}),
      ...(this.windowWarning(id) ? { warning: this.windowWarning(id) } : {}) }));
  }
  async open(id, options = {}) {
    if (this.kernelMaintenance || this.shuttingDown) throw Object.assign(new Error('正在管理浏览器内核或退出应用，请完成后再打开环境'), { status: 409 });
    if (this.closing.has(id)) await this.closing.get(id);
    if (this.kernelMaintenance || this.shuttingDown) throw Object.assign(new Error('正在管理浏览器内核或退出应用，请完成后再打开环境'), { status: 409 });
    if (this.opening.has(id)) return this.opening.get(id);
    if (!this.sessions.has(id) && this.contexts.has(id)) throw Object.assign(new Error('旧浏览器进程正在退出，请先关闭环境'), { status: 409 });
    this.cancelled.delete(id);
    const pending = this._open(id, options);
    this.opening.set(id, pending);
    try { return await pending; } finally { this.opening.delete(id); if (!this.closing.has(id)) this.cancelled.delete(id); }
  }
  async _open(id, { headless = false } = {}) {
    if (typeof headless !== 'boolean') throw Object.assign(new Error('headless 必须为布尔值'), { status: 400 });
    const profile = this.store.get(id);
    if (!profile) throw Object.assign(new Error('环境不存在'), { status: 404 });
    if (profile.deleting) throw Object.assign(new Error('环境正在等待清理，不能打开'), { status: 409 });
    if (this.sessions.has(id)) return { profile_id: id, open: true, reused: true, ...this.listOpen().find(s => s.profile_id === id) };
    validateProfile(profile);
    const checkCancelled = () => { if (this.cancelled.has(id)) throw Object.assign(new Error('环境启动已取消'), { status: 409 }); };
    const networkCheck = this.store.beginNetworkCheck(id);
    const savedProxy = profile.proxyId ? this.proxyStore?.beginCheck(profile.proxyId) : null;
    const route = await prepareProxyRoute(savedProxy?.proxy ?? resolveProxy(profile, this.proxyStore), this.settings);
    const { proxy: proxyRecord } = route;
    const checkRoute = () => {
      checkCancelled();
      route.assertCurrent();
      const current = this.store.get(id);
      if (!current || current.deleting || current.updatedAt !== profile.updatedAt ||
          (savedProxy && !savedProxy.current()) ||
          JSON.stringify([current.proxyId, current.proxy]) !== JSON.stringify([profile.proxyId, profile.proxy])) {
        throw Object.assign(new Error('环境或代理在检测期间发生变化，请重试'), { status: 409 });
      }
    };
    checkRoute();
    const effective = { ...profile };
    let network = { route: proxyRecord ? 'proxy' : 'system', ...exitAddresses({}) };
    let forwarder, context, windowToken, windowBridge, windowControl, graphicsMode, timezoneWarning, graphicsFallback = false;
    const trackContext = launched => {
      this.contexts.set(id, launched);
      const process = ownedBrowser(launched)?.process;
      const forget = () => { if (this.contexts.get(id) === launched) this.contexts.delete(id); };
      if (process) process.once('exit', forget);
      launched.once('close', () => { if (!process || process.exitCode != null || process.signalCode != null) forget(); });
    };
    try {
      const transport = await openProxyTransport(route);
      forwarder = transport.forwarder;
      checkRoute();
      if (proxyRecord) {
        const result = await this.checkProxy(proxyRecord, this.settings, route, transport);
        checkRoute();
        savedProxy?.save(result);
        if (result.status !== 'ok') throw Object.assign(new Error(result.error || '代理检测失败，已阻止启动'), {
          status: 502, proxyCode: result.code || 'PROXY_EXIT',
        });
        if (isAutomaticTimezone(profile.timezone)) effective.timezone = result.timezone;
        if (profile.locale === 'auto') effective.locale = localeForCountry(result.countryCode);
        const missing = [
          !effective.locale && (result.countryCode ? '代理出口地区没有对应的语言' : '代理出口地区未知'),
          !effective.timezone && '代理出口时区未知',
        ].filter(Boolean);
        if (missing.length) throw Object.assign(new Error(`出口 IP 已验证，但${missing.join('、')}。请重试或手动选择语言和时区。`),
          { status: 409, proxyCode: 'PROXY_REGION' });
        network = { route: 'proxy', ...exitAddresses(result), checkedAt: new Date().toISOString(), timezone: effective.timezone, locale: effective.locale };
      } else if (profile.timezone === 'ip') {
        const result = await this.checkDirectNetwork().catch(() => null);
        checkRoute();
        if (result) {
          effective.timezone = result.timezone;
          network = { route: 'system', ...exitAddresses(result), checkedAt: new Date().toISOString(), timezone: effective.timezone };
        } else {
          effective.timezone = 'auto';
          timezoneWarning = '公网出口时区查询失败，本次使用系统时区';
        }
      }
      const proxy = ProxyStore.toPlaywright(transport.proxy);
      if (proxy) proxy.bypass = '<-loopback>';
      const kernel = profile.fingerprintMode === 'kernel';
      if (kernel && process.env.LFB_EXPOSE_DEBUGGER === '1') throw new Error('Camoufox 使用 Firefox 协议，不提供 Chromium CDP 调试端口');
      const workArea = !headless && process.platform === 'win32' && profile.display ? this.getDisplayWorkArea?.() : null;
      if (workArea) {
        effective.display = fitWindowsDisplay(profile.display, workArea);
        if (!effective.display) throw Object.assign(new Error('当前屏幕的可用区域放不下此显示预设，请选择较小的分辨率或跟随系统'), { status: 409 });
      }
      const { options, display } = buildContextOptions({ ...effective, proxy });
      const manageWindows = !display && !headless && process.platform === 'win32' && !kernel;
      const debugPort = !kernel && process.env.LFB_EXPOSE_DEBUGGER === '1' ? await findFreePort(4550, 4599) : null;
      const switches = kernel ? null : await chromiumBrowsingSwitches(chromium);
      const launchOptions = { ...options, headless, chromiumSandbox: true,
        ignoreDefaultArgs: switches?.ignoreDefaultArgs,
        args: ['--no-first-run', '--no-default-browser-check', '--site-per-process', '--disable-background-mode',
          ...(switches?.args || []),
          '--disable-blink-features=AutomationControlled',
          ...(!kernel && effective.userAgent ? [`--user-agent=${effective.userAgent}`] : []),
          ...(effective.locale !== 'auto' ? [`--lang=${effective.locale}`, `--accept-lang=${effective.locale}`] : []),
          ...(debugPort ? [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'] : []),
          ...webrtcArgs({ ...effective, proxy: proxy || profile.webrtc === 'auto' }),
        ],
      };
      if (manageWindows) {
        await this.windowStates.capture();
        const state = this.windowStates.desired();
        launchOptions.viewport = null;
        delete launchOptions.deviceScaleFactor;
        launchOptions.args.push(state === 'fullscreen' ? '--start-fullscreen' : state === 'maximized'
          ? '--start-maximized' : `--window-size=${profile.viewport.width},${profile.viewport.height}`);
      }
      if (display && !kernel && workArea) {
        const position = fittedWindowsWindowPosition(display.viewport, workArea);
        if (position) launchOptions.args.push(`--window-position=${position.x},${position.y}`);
      }
      // Deliberately no arbitrary LFB_EXTRA_ARGS: they could disable sandbox,
      // alter proxy routing or invalidate the native consistency contract.
      if (!kernel) {
        const executable = process.env.LFB_CHROMIUM_EXECUTABLE || await this.resolveChromium?.();
        if (executable) launchOptions.executablePath = executable;
      }
      checkCancelled();
      if (!kernel && !headless && this.profileIcons) {
        launchOptions.executablePath = await require('./profileapp').ensureProfileApp(this.store.dataDir, profile, launchOptions.executablePath || chromium.executablePath());
        checkCancelled();
      }
      const directory = kernel ? path.join(this.store.profileDir(id), 'firefox') : this.store.profileDir(id);
      privateDirectory(directory);
      const dnsMode = this.settings?.get().dnsMode ?? DEFAULT_DNS_MODE;
      if (kernel) {
        const firefoxDNSMode = await selectFirefoxDNSMode(dnsMode, proxy);
        checkRoute();
        const downloadsDirectory = this.downloadsDirectory || path.join(os.homedir(), 'Downloads');
        await fs.promises.mkdir(downloadsDirectory, { recursive: true });
        let bridge;
        if (!headless && !display) {
          windowToken = crypto.randomBytes(24).toString('hex');
          this.windowTokens.set(windowToken, { profileId: id, ready: false });
          windowControl = { token: windowToken, unavailable: false };
          try {
            if (!this.createWindowBridge) throw new Error('window service unavailable');
            windowBridge = await this.createWindowBridge(windowToken);
            bridge = { url: windowBridge.url, token: windowToken };
          } catch (error) {
            windowControl.unavailable = true;
            this.windowTokens.delete(windowToken);
            console.error('[CIKE] window control:', error.code || error.message);
          }
        }
        const graphics = this.settings?.get();
        checkRoute();
        ({ context, graphicsMode, graphicsFallback } = await launchWithGraphics(mode => require('./native-runtime').launchNative({
          dataDir: this.store.dataDir, directory, profile: effective, proxy, headless, downloadsDirectory, bridge, display, dnsMode: firefoxDNSMode, graphicsMode: mode,
          onContext: trackContext,
        }), { mode: graphics?.camoufoxGraphicsMode || 'auto', remembered: graphics?.camoufoxAutoSoftware === true, beforeRetry: () => {
          checkRoute();
          const entry = this.windowTokens.get(windowToken); if (entry) entry.ready = false;
        } }));
        let closed = false;
        context.once('close', () => { closed = true; });
        if (bridge) {
          const deadline = Date.now() + 3000;
          while (!this.windowTokens.get(windowToken)?.ready) {
            checkCancelled();
            if (closed) throw new Error('浏览器已关闭');
            // Window sizing is auxiliary. Keep a healthy proxied browser open
            // while the extension reconnects instead of treating it as a crash.
            if (Date.now() > deadline) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        if (closed) throw new Error('浏览器已关闭');
      } else {
        await prepareDownloads(directory, this.downloadsDirectory);
        checkRoute();
        prepareChromiumDNS(directory, dnsMode, proxy);
        context = await chromium.launchPersistentContext(directory, launchOptions);
        trackContext(context);
      }
      if (profile.fingerprintMode === 'hardware') await require('./hardware-runtime').installHardwareContext(context, profile);
      if (manageWindows) await this.windowStates.attach(context);
      if (!kernel) await configureDownloads(context);
      checkRoute();
      const session = { context, debugPort, headless, openedAt: Date.now(), forwarder, network, windowControl, graphicsMode };
      this.sessions.set(id, session);
      this.crashes.delete(id);
      context.on('close', () => { if (windowToken) this.windowTokens.delete(windowToken); if (this.sessions.get(id) === session) this.sessions.delete(id); forwarder?.stop().catch(() => {}); windowBridge?.close().catch(() => {}); });
      const watchPage = page => { page.on('crash', () => this.crashes.set(id, { time: new Date().toISOString() })); page.on('close', () => {
        // macOS leaves Chromium alive after its final window closes. Closing
        // the persistent context terminates only this environment's process.
        // Firefox may dispose a Juggler target during native-tab/process
        // replacement while its real window is still alive. Its page list is
        // not a window-lifetime signal; let Firefox exit on its last window.
        if (!kernel && !context.pages().some(p => !p.isClosed()) && this.sessions.get(id) === session) this.close(id).catch(() => {});
      }); };
      context.on('page', watchPage);
      for (const page of context.pages()) watchPage(page);
      if (!headless && this.startPage) await require('./startpage').openStartPage(context, profile, network, () => {
        const check = this.store.beginNetworkCheck(id);
        return addresses => {
          if (this.sessions.get(id) !== session) return;
          const observed = { ...session.network, ...addresses, checkedAt: new Date().toISOString() };
          if (check.save(observed)) session.network = observed;
        };
      }, graphicsMode, () => this.store.list());
      checkCancelled();
      if (graphicsFallback) this.settings?.rememberCamoufoxSoftware();
      this.store.recordOpened(id, networkCheck.current() ? session.network : null);
      const warning = [
        effective.display?.scale !== profile.display?.scale ? `本次显示缩放已自动调整为 ${effective.display.scale}%` : null,
        timezoneWarning,
        graphicsFallback ? '检测到 GPU/D3D11 启动失败，已自动使用兼容绘制' : null,
        this.windowWarning(id),
      ].filter(Boolean).join('；');
      return { profile_id: id, open: true, reused: false, headless, network,
        ...(graphicsMode ? { graphicsMode } : {}),
        ...(warning ? { warning } : {}),
        ...(debugPort ? { debug_url: `http://127.0.0.1:${debugPort}` } : {}) };
    } catch (error) {
      if (windowToken) this.windowTokens.delete(windowToken);
      await stopContext(context || this.contexts.get(id)).catch(() => {});
      await forwarder?.stop().catch(() => {});
      await windowBridge?.close().catch(() => {});
      // Playwright launch errors include argv, but proxy credentials are not
      // in argv. Do not retry by disabling sandbox or removing the proxy.
      throw error;
    }
  }
  async close(id) {
    if (this.closing.has(id)) return this.closing.get(id);
    this.cancelled.add(id);
    const pending = (async () => {
      await within(() => this.opening.get(id)?.catch(() => {}), 2000);
      const session = this.sessions.get(id);
      const context = session?.context || this.contexts.get(id);
      if (context) {
        if (session && !session.headless && process.platform === 'win32') await within(() => this.windowStates.capture().catch(() => {}), 500);
        await stopContext(context);
        await session?.forwarder?.stop();
        if (this.sessions.get(id) === session) this.sessions.delete(id);
        if (this.contexts.get(id) === context) this.contexts.delete(id);
      }
      if (this.opening.has(id)) throw Object.assign(new Error('正在取消启动，请稍后重试'), { status: 409 });
      return { profile_id: id, open: false };
    })();
    this.closing.set(id, pending);
    try { return await pending; } finally { this.closing.delete(id); if (!this.opening.has(id)) this.cancelled.delete(id); }
  }
  async closeAll() {
    const ids = [...new Set([...this.opening.keys(), ...this.sessions.keys(), ...this.contexts.keys()])];
    await Promise.all(ids.map(id => this.close(id)));
    return { closed: ids.length };
  }
  getContext(id) { return this.sessions.get(id)?.context || null; }
  async openSitePermissions(id) {
    const profile = this.store.get(id);
    if (!profile) throw Object.assign(new Error('环境不存在'), { status: 404 });
    const session = this.sessions.get(id);
    if (!session || session.headless || profile.deleting || this.closing.has(id)) {
      throw Object.assign(new Error('请先打开此环境，再管理网站权限'), { status: 409 });
    }
    let page, timedOut = false;
    try {
      const opened = await within(async () => {
        page = await session.context.newPage();
        if (timedOut) { await page.close(); return; }
        if (profile.fingerprintMode === 'kernel') {
          await require('./native-runtime').openNativeSitePermissions(page);
        } else {
          await page.goto('chrome://settings/content', { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.bringToFront();
        }
      }, 15000);
      if (!opened.completed) { timedOut = true; throw new Error('网站权限页面打开超时'); }
    } catch (error) {
      if (page) await within(() => page.close(), 1000).catch(() => {});
      throw new Error('无法打开网站权限页面，请从此环境的浏览器设置进入', { cause: error });
    }
  }
  async forceStopAll() {
    await Promise.allSettled([...this.contexts.values()].map(context => forceStopContext(context)));
  }
  async manageKernel(operation) {
    if (this.shuttingDown) throw new Error('应用正在退出');
    if (this.kernelMaintenance) throw new Error('另一项内核操作正在进行，请稍后再试');
    if (this.sessions.size || this.opening.size || this.closing.size || this.contexts.size) throw new Error('请先关闭所有浏览器环境，再管理内核');
    this.kernelMaintenance = true;
    const task = Promise.resolve().then(operation); this.kernelTask = task;
    try { return await task; }
    finally { this.kernelMaintenance = false; if (this.kernelTask === task) this.kernelTask = null; }
  }
}
module.exports = { BrowserManager };
