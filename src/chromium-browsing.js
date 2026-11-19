'use strict';

const restore = new Set(['HttpsUpgrades', 'ThirdPartyStoragePartitioning']);

async function chromiumBrowsingSwitches(chromium) {
  // Playwright filters exact arguments. Keep the controls it needs, but remove
  // these two features from its combined --disable-features argument.
  const implementation = chromium._connection?.toImpl?.(chromium);
  const defaults = await implementation?.defaultArgs?.({ chromiumSandbox: true }, true, '.');
  if (!defaults) throw new Error('无法检查当前 Playwright 的 Chromium 启动设置');
  const ignoreDefaultArgs = ['--enable-automation', '--disable-background-networking',
    '--disable-client-side-phishing-detection', '--disable-component-update'];
  const args = [];
  const prefix = '--disable-features=';
  for (const arg of defaults.filter(value => value.startsWith(prefix))) {
    const features = arg.slice(prefix.length).split(',');
    const retained = features.filter(feature => !restore.has(feature));
    if (features.length === retained.length) continue;
    ignoreDefaultArgs.push(arg);
    if (retained.length) args.push(prefix + retained.join(','));
  }
  return { ignoreDefaultArgs, args };
}

module.exports = { chromiumBrowsingSwitches };
