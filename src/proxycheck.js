'use strict';
const { spawn } = require('child_process');
const net = require('net');
const { proxyURL, validateProxy } = require('./proxyconfig');
const { SocksForwarder } = require('./socksfwd');
const { curlRuntime } = require('./platform');
const quote = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';

function curl(proxy, url, timeoutMs = 12000) {
  // -q disables ~/.curlrc. Empty noproxy prevents NO_PROXY from silently
  // bypassing the selected proxy. Secrets go over stdin, never argv/errors.
  const config = ['silent', 'show-error', 'fail', `max-time = ${Math.ceil(timeoutMs / 1000)}`,
    'connect-timeout = 8', 'noproxy = ""', `proxy = ${quote(proxyURL(proxy, true))}`,
    `url = ${quote(url)}`, ...(proxy.username || proxy.password ? [`proxy-user = ${quote(`${proxy.username || ''}:${proxy.password || ''}`)}`] : [])].join('\n') + '\n';
  return new Promise((resolve, reject) => {
    const runtime = curlRuntime();
    const child = spawn(runtime.executable, ['-q', '--config', '-'], {
      env: runtime.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '', tooLarge = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 1000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 256 * 1024) { tooLarge = true; child.kill('SIGKILL'); }
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error(process.platform === 'win32'
      ? '无法启动系统 curl；Windows 需要 Windows 10 1803 或更新版本自带的 curl.exe' : '无法启动系统 curl')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code || tooLarge) reject(new Error(`代理请求失败（curl ${code ?? 'timeout'}）；请检查连接、认证和证书`));
      else resolve(output.trim());
    });
    child.stdin.end(config);
  });
}
async function prepareProxyRoute(proxy, settings) {
  const relevant = !proxy || proxy.type === 'socks5';
  const enabled = settings?.get().socksViaSystemProxy === true;
  const revision = settings?.proxyRevision;
  const assertCurrent = () => {
    if (relevant && ((settings?.get().socksViaSystemProxy === true) !== enabled || settings?.proxyRevision !== revision)) {
      throw Object.assign(new Error('系统代理设置在检测期间发生变化，请重试'), { status: 409 });
    }
  };
  let upstream = null;
  if (relevant && enabled) {
    upstream = await settings.route(proxy?.host, proxy?.port);
    assertCurrent();
    if (!upstream) throw Object.assign(new Error('系统代理不可用，已阻止启动'), { status: 409 });
  }
  const selected = proxy || (upstream && { type: upstream.scheme, host: upstream.host, port: upstream.port });
  if (selected) validateProxy(selected);
  return { proxy: selected, systemProxy: proxy ? upstream : null, assertCurrent };
}

async function checkProxy(proxy, settings, preparedRoute) {
  let forwarder;
  try {
    validateProxy(proxy);
    const route = preparedRoute ?? await prepareProxyRoute(proxy, settings);
    route.assertCurrent();
    let effective = proxy;
    if (route.systemProxy) {
      forwarder = await SocksForwarder.start({ ...proxy, systemProxy: route.systemProxy });
      effective = { type: 'http', host: '127.0.0.1', port: forwarder.port };
    }
    // Both endpoints are HTTPS and always use exactly the selected route.
    const exitIp = await curl(effective, 'https://api.ipify.org');
    if (!net.isIP(exitIp)) throw new Error('代理 IP 检测响应无效');
    let country = null, countryCode = null, timezone = null;
    try {
      const geo = JSON.parse(await curl(effective, `https://ipwho.is/${encodeURIComponent(exitIp)}`));
      if (geo.success !== false && geo.ip === exitIp) {
        country = typeof geo.country === 'string' ? geo.country : null;
        countryCode = /^[A-Z]{2}$/.test(geo.country_code) ? geo.country_code : null;
        timezone = geo.timezone?.id || null;
        if (timezone) new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
      }
    } catch { timezone = null; }
    return { status: 'ok', exitIp, country, countryCode, timezone };
  } catch (error) {
    return { status: 'failed', exitIp: null, country: null, countryCode: null, timezone: null, error: error.message };
  } finally { await forwarder?.stop(); }
}
module.exports = { checkProxy, prepareProxyRoute, curl };
