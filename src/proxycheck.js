'use strict';
const { spawn } = require('child_process');
const net = require('net');
const { proxyURL, validateProxy } = require('./proxyconfig');
const { SocksForwarder } = require('./socksfwd');
const { curlRuntime } = require('./platform');
const quote = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
const EXIT_PROBE_FAILED = '出口 IP 检测未通过。请重试，或确认代理可访问 ipify 检测服务。';

function probeError(proxyCode, message) {
  return Object.assign(new Error(message), { proxyCode });
}

function curl(proxy, url, timeoutMs = 12000, forwarded = false) {
  // -q disables ~/.curlrc. Empty noproxy prevents NO_PROXY from silently
  // bypassing the selected proxy. Secrets go over stdin, never argv/errors.
  const config = ['silent', 'show-error', 'fail', `max-time = ${Math.ceil(timeoutMs / 1000)}`,
    'connect-timeout = 8', 'noproxy = ""', `proxy = ${quote(proxyURL(proxy, true))}`,
    `url = ${quote(url)}`, ...(proxy.username || proxy.password ? [`proxy-user = ${quote(`${proxy.username || ''}:${proxy.password || ''}`)}`] : [])].join('\n') + '\n';
  return new Promise((resolve, reject) => {
    const runtime = curlRuntime();
    // CONNECT and origin HTTP status are separate, even when curl --fail exits nonzero.
    const child = spawn(runtime.executable, ['-q', '--config', '-', '--write-out', '\n%{http_connect} %{http_code}'], {
      env: runtime.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '', tooLarge = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 1000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 256 * 1024) { tooLarge = true; child.kill('SIGKILL'); }
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(probeError('PROXY_RUNTIME', process.platform === 'win32'
      ? '无法启动系统 curl；Windows 需要 Windows 10 1803 或更新版本自带的 curl.exe' : '无法启动系统 curl')); });
    child.once('close', code => {
      clearTimeout(timer);
      const status = /\n(\d{3}) (\d{3})$/.exec(output);
      const tunnel = Number(status?.[1]), response = Number(status?.[2]);
      if (code === 0 && status && !tooLarge) return resolve(output.slice(0, status.index).trim());
      if (forwarded && tunnel === 424) {
        return reject(probeError('PROXY_ROUTE', '无法通过系统代理连接 SOCKS5 服务。请检查系统代理规则和认证。'));
      }
      if (tunnel === 407 || (forwarded && tunnel === 403) || code === 67 ||
          (response === 407 && proxy.type !== 'socks5' && url.startsWith('http:'))) {
        return reject(probeError('PROXY_AUTH', '代理认证失败。请核对用户名、密码和认证方式。'));
      }
      if (code === 5 || code === 7 || (forwarded && tunnel === 503)) {
        return reject(probeError('PROXY_CONNECTION', '无法连接代理服务器。请检查代理地址、端口、协议和网络。'));
      }
      reject(probeError('PROXY_EXIT', EXIT_PROBE_FAILED));
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
    try { upstream = await settings.route(proxy?.host, proxy?.port); }
    catch { /* A missing system route blocks startup below. */ }
    assertCurrent();
    if (!upstream) throw Object.assign(probeError('PROXY_ROUTE', '系统代理不可用。请检查系统代理及 SOCKS5 两跳设置。'), { status: 409 });
  }
  const selected = proxy || (upstream && { type: upstream.scheme, host: upstream.host, port: upstream.port });
  if (selected) validateProxy(selected);
  return { proxy: selected, systemProxy: proxy ? upstream : null, assertCurrent };
}

async function openProxyTransport(route) {
  const { proxy, systemProxy } = route;
  if (proxy?.type !== 'socks5' || !(proxy.username || proxy.password || systemProxy)) return { proxy };
  const forwarder = await SocksForwarder.start({ ...proxy, systemProxy }).catch(() => {
    throw Object.assign(probeError('PROXY_RUNTIME', '无法启动本机 SOCKS5 中转。请重试或重新启动 CIKE。'), { status: 502 });
  });
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
  if (!exitIp) {
    for (const code of ['PROXY_AUTH', 'PROXY_ROUTE', 'PROXY_CONNECTION', 'PROXY_RUNTIME']) {
      const failure = probes.find(probe => probe.reason?.proxyCode === code);
      if (failure) throw failure.reason;
    }
    if (probes.some(probe => probe.status === 'fulfilled')) {
      throw probeError('PROXY_EXIT', '出口 IP 检测服务响应无效。请重新检测。');
    }
    throw probeError('PROXY_EXIT', EXIT_PROBE_FAILED);
  }
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
    const network = await readProxyNetwork(transport.proxy, (record, url) => curl(record, url, 12000, !!transport.forwarder));
    const warning = network.countryCode && network.timezone ? null : '出口 IP 已验证，但地区或时区信息不完整。自动设置不可用时，可手动选择语言和时区。';
    return { status: 'ok', ...network, ...(warning && { warning }) };
  } catch (error) {
    return { status: 'failed', ...exitAddresses({}), country: null, countryCode: null, timezone: null,
      error: error.message, ...(error.proxyCode && { code: error.proxyCode }) };
  } finally { await ownedTransport?.forwarder?.stop(); }
}

async function checkDirectNetwork(request = fetch) {
  const response = await request('https://ipwho.is/?fields=success,ip,timezone.id', {
    signal: AbortSignal.timeout(5000), cache: 'no-store', credentials: 'omit', redirect: 'error',
  });
  if (!response.ok) throw new Error('公网出口时区查询失败');
  const result = await response.json();
  const addresses = exitAddresses({ exitIp: result?.ip });
  const timezone = result?.timezone?.id;
  if (result?.success !== true || !addresses.exitIp || typeof timezone !== 'string') throw new Error('公网出口时区查询响应无效');
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  return { ...addresses, timezone };
}

module.exports = { checkProxy, checkDirectNetwork, prepareProxyRoute, openProxyTransport, readProxyNetwork, exitAddresses, curl };
