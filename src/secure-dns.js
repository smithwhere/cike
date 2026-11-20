'use strict';
const path = require('path');
const https = require('https');
const { readJSON, writeJSON } = require('./privatefiles');

const PROVIDERS = {
  cloudflare: { ip: '1.1.1.1', url: 'https://cloudflare-dns.com/dns-query' },
  google: { ip: '8.8.8.8', url: 'https://dns.google/dns-query' },
};
const DNS_MODES = ['public', 'cloudflare', 'google', 'system'];
const DEFAULT_DNS_MODE = 'public';
// A fixed, non-user query for example.com A checks the configured HTTPS endpoint.
const TEST_QUERY = 'AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE';

function canReachProvider({ ip, url }) {
  return new Promise((resolve, reject) => {
    https.get(`${url}?dns=${TEST_QUERY}`, {
      agent: false,
      signal: AbortSignal.timeout(1800),
      headers: { Accept: 'application/dns-message' },
      lookup: (_hostname, options, done) => {
        if (options.all) done(null, [{ address: ip, family: 4 }]);
        else done(null, ip, 4);
      },
    }, response => {
      response.on('error', () => resolve(false));
      response.resume();
      resolve(response.statusCode === 200 && /^application\/dns-message\b/i.test(response.headers['content-type'] || ''));
    }).once('error', reject);
  }).catch(() => false);
}

async function selectFirefoxDNSMode(mode, proxy, checkProvider = canReachProvider) {
  if (proxy || mode !== 'public') return mode;
  if (await checkProvider(PROVIDERS.cloudflare)) return 'cloudflare';
  return 'google';
}

function prepareChromiumDNS(directory, mode, proxy) {
  const filename = path.join(directory, 'Local State');
  const state = readJSON(filename, {});
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Chromium Local State 格式无效');
  // HTTP CONNECT and SOCKS5 delegate destination lookup to the proxy.
  // Disable browser DoH for this launch so it cannot open a second DNS route.
  const providers = proxy || mode === 'system' ? []
    : mode === 'public' ? Object.values(PROVIDERS) : [PROVIDERS[mode]];
  const dns = {
    ...state.dns_over_https,
    mode: providers.length ? 'secure' : 'off',
    templates: providers.length ? JSON.stringify({
      servers: providers.map(({ ip, url }) => ({ template: url, endpoints: [{ ips: [ip] }] })),
    }) : '',
  };
  if (state.dns_over_https?.mode === dns.mode && state.dns_over_https?.templates === dns.templates) return;
  writeJSON(filename, { ...state, dns_over_https: dns });
}

function firefoxDNSPreferences(mode, proxy) {
  // Firefox can use only one configured DoH endpoint per browser session.
  const provider = PROVIDERS[mode === 'public' ? 'cloudflare' : mode];
  return {
    'network.trr.mode': proxy || !provider ? 5 : 3,
    'network.trr.uri': !proxy && provider ? provider.url : '',
    'network.trr.bootstrapAddr': !proxy && provider ? provider.ip : '',
  };
}

module.exports = { DEFAULT_DNS_MODE, DNS_MODES, prepareChromiumDNS, selectFirefoxDNSMode, firefoxDNSPreferences };
