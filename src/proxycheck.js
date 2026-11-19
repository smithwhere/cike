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
      if (code !== 0 || tooLarge) reject(new Error(`代理请求失败（curl ${code ?? 'timeout'}）；请检查连接、认证和证书`));
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

async function openProxyTransport(route) {
  const { proxy, systemProxy } = route;
  if (proxy?.type !== 'socks5' || !(proxy.username || proxy.password || systemProxy)) return { proxy };
  const forwarder = await SocksForwarder.start({ ...proxy, systemProxy });
  return { proxy: { type: 'http', host: '127.0.0.1', port: forwarder.port }, forwarder };
}

function normalizeIp(value, family) {
  if (typeof value !== 'string' || net.isIP(value) !== family) return null;
  if (family === 4) return value;
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return null; }
}

function exitAddresses({ exitIp, exitIPv4, exitIPv6 }) {
  const ipv4 = normalizeIp(exitIPv4 ?? exitIp, 4);
  const ipv6 = normalizeIp(exitIPv6 ?? exitIp, 6);
  return { exitIp: ipv4 || ipv6, exitIPv4: ipv4, exitIPv6: ipv6 };
}

async function readProxyNetwork(proxy, request = curl) {
  const probes = await Promise.allSettled([
    request(proxy, 'https://api.ipify.org'), request(proxy, 'https://api6.ipify.org'),
  ]);
  const addresses = exitAddresses({ exitIPv4: probes[0].value, exitIPv6: probes[1].value });
  const { exitIp } = addresses;
  if (!exitIp) throw probes.find(probe => probe.status === 'rejected')?.reason || new Error('代理 IP 检测响应无效');
  let country = null, countryCode = null, timezone = null;
  try {
    const geo = JSON.parse(await request(proxy, `https://ipwho.is/${encodeURIComponent(exitIp)}`));
    if (geo.success !== false && normalizeIp(geo.ip, net.isIP(exitIp)) === exitIp) {
      country = typeof geo.country === 'string' ? geo.country : null;
      countryCode = /^[A-Z]{2}$/.test(geo.country_code) ? geo.country_code : null;
      timezone = typeof geo.timezone?.id === 'string' ? geo.timezone.id : null;
      if (timezone) new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    }
  } catch { timezone = null; }
  return { ...addresses, country, countryCode, timezone };
}

async function checkProxy(proxy, settings, preparedRoute, transport) {
  let ownedTransport;
  try {
    validateProxy(proxy);
    const route = preparedRoute ?? await prepareProxyRoute(proxy, settings);
    route.assertCurrent();
    if (!transport) transport = ownedTransport = await openProxyTransport(route);
    return { status: 'ok', ...(await readProxyNetwork(transport.proxy)) };
  } catch (error) {
    return { status: 'failed', ...exitAddresses({}), country: null, countryCode: null, timezone: null, error: error.message };
  } finally { await ownedTransport?.forwarder?.stop(); }
}
module.exports = { checkProxy, prepareProxyRoute, openProxyTransport, readProxyNetwork, exitAddresses, curl };
