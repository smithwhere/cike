'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { exitAddresses } = require('./proxycheck');
const { syntheticSamples } = require('./synthetic-samples');
const { syntheticComparison } = require('./synthetic-comparison');
const ORIGIN = 'https://start.cike.invalid';

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const html = value => String(value).replace(/[&<>"']/g, character => HTML_ENTITIES[character]);

function comparisonSelect(name, label, options, selected) {
  const items = options.map(({ key, label: optionLabel }) =>
    `<option value="${html(key)}"${key === selected?.key ? ' selected' : ''}>${html(optionLabel)}</option>`).join('');
  return `<div><label for="compare-${name}">${label}</label><select id="compare-${name}" name="${name}">${items}</select></div>`;
}

function renderComparison({ options, left, right, error, rows }) {
  if (options.length < 2) return `
  <section id="compare" class="sample-comparison" aria-labelledby="compare-heading">
    <h2 id="compare-heading">对比环境</h2>
    <p>至少需要两个独立环境才能对比。</p>
  </section>`;

  const result = rows ? `
    <div class="sample-table-scroll">
      <table id="comparison-results" aria-label="合成摘要对比结果">
        <thead><tr><th scope="col">项目</th><th scope="col">${html(left.label)}</th><th scope="col">${html(right.label)}</th><th scope="col">结果</th></tr></thead>
        <tbody>${rows.map(({ label, left: leftDigest, right: rightDigest, same }) => `
          <tr>
            <th scope="row">${html(label)}</th>
            <td><code>${html(leftDigest)}</code></td>
            <td><code>${html(rightDigest)}</code></td>
            <td><span class="sample-status ${same ? 'same' : 'different'}">${same ? '相同' : '不同'}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  return `
  <section id="compare" class="sample-comparison" aria-labelledby="compare-heading">
    <h2 id="compare-heading">对比环境</h2>
    <form class="sample-comparison-form" action="/samples#compare" method="get">
      ${comparisonSelect('left', '环境 A', options, left)}
      ${comparisonSelect('right', '环境 B', options, right)}
      <button type="submit">对比</button>
    </form>
    ${error ? `<p class="sample-error" role="alert">${html(error)}</p>` : ''}
    ${result}
  </section>`;
}

function renderSyntheticPage(profile, comparison) {
  const number = Number(profile.sequence);
  const samples = syntheticSamples(profile.id).map(({ label, value, digest }) => `
    <article>
      <h2>${label}</h2>
      <code data-sample="${label}">${digest}</code>
      <p>${value}</p>
    </article>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>#${number} · CIKE 本地合成样本</title>
  <link rel="icon" href="/icon.svg">
  <link rel="stylesheet" href="/start.css">
</head>
<body>
<main>
  <header>
    <span class="badge">#${number}</span>
    <h1>本地合成样本</h1>
  </header>
  <p>下面四项是用于本地测试的合成数据。重开同一环境会得到相同的样本和摘要。</p>
  ${renderComparison(comparison)}
  <section class="grid sample-grid" aria-label="合成样本与摘要">${samples}
  </section>
  <p><a href="/">返回环境检测</a></p>
</main>
</body>
</html>`;
}

async function openStartPage(context, profile, network, beginCheck, graphicsMode, listProfiles = () => [profile]) {
  const page = context.pages()[0] || await context.newPage();
  const root = path.join(__dirname, '..', 'electron', 'start');
  const software = profile.fingerprintMode === 'hardware';
  const config = {
    name: profile.name, sequence: profile.sequence, proxy: network.route === 'proxy', expected: exitAddresses(network),
    mode: profile.fingerprintMode, canvasProcessing: software && profile.canvasNoise === true,
    browserVersion: context.browser()?.version() || null,
    gpuPreset: require('./hardware').GPU_PRESETS[profile.gpuPreset]?.name || '原生显卡',
    graphicsMode: graphicsMode ?? null,
    restrictWebRTC: network.route === 'proxy' || profile.webrtc !== 'default',
  };
  const assets = { '/': ['index.html', 'text/html'], '/start.js': ['start.js', 'text/javascript'], '/start.css': ['start.css', 'text/css'] };
  // A reserved .invalid origin is fulfilled only inside this page. No local
  // API token, proxy password, listening port or browser-wide JS binding.
  let pendingCheck;
  await page.route(ORIGIN + '/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' https://api.ipify.org https://api6.ipify.org https://ipwho.is; frame-ancestors 'none'" };
    if (['/check', '/result'].includes(url.pathname) && req.method() === 'POST') {
      if (req.headers().origin !== ORIGIN || page.url() !== ORIGIN + '/') return route.fulfill({ status: 403, body: '' });
      if (url.pathname === '/check') {
        pendingCheck = { id: randomUUID(), finish: beginCheck() };
        return route.fulfill({ headers, json: { id: pendingCheck.id } });
      }
      try {
        const data = req.postDataJSON();
        if (!pendingCheck || pendingCheck.id !== data.id) return route.fulfill({ status: 409, body: '' });
        const { finish } = pendingCheck;
        pendingCheck = null;
        const addresses = exitAddresses({ exitIPv4: data.exitIPv4, exitIPv6: data.exitIPv6 });
        finish(addresses);
        return route.fulfill({ headers, json: addresses });
      } catch { return route.fulfill({ status: 400, body: '' }); }
    }
    if (req.method() !== 'GET') return route.fulfill({ status: 405, body: '' });
    if (url.pathname === '/samples') {
      if (!req.isNavigationRequest() || req.frame() !== page.mainFrame() || new URL(page.url()).origin !== ORIGIN) {
        return route.fulfill({ status: 403, body: '' });
      }
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        headers: {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
        body: renderSyntheticPage(profile, syntheticComparison(listProfiles(), profile.id, url.searchParams)),
      });
    }
    if (url.pathname === '/config.js') return route.fulfill({ headers, contentType: 'text/javascript', body: 'window.cikeEnvironment=' + JSON.stringify(config) + ';' });
    if (url.pathname === '/icon.svg') return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="16" fill="#172b48"/><text x="32" y="43" text-anchor="middle" fill="white" font-size="${String(profile.sequence).length > 3 ? 18 : 30}" font-family="sans-serif">${Number(profile.sequence)}</text></svg>` });
    const file = assets[url.pathname];
    return file ? route.fulfill({ headers, contentType: file[1], body: fs.readFileSync(path.join(root, file[0])) }) : route.fulfill({ status: 404, body: '' });
  });
  await page.goto(ORIGIN + '/');
  return page;
}
module.exports = { openStartPage, START_ORIGIN: ORIGIN };
