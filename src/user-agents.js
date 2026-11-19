'use strict';
const crypto = require('crypto');
const catalog = require('./user-agents.json');
const CHROMIUM_VERSION = require('./chromium-version');

function userAgentPresets(platform, { includeLegacy = true } = {}) {
  const presets = typeof platform === 'string' && Object.hasOwn(catalog, platform) ? catalog[platform] : { hardware: [], kernel: [] };
  if (platform !== 'win') return presets;
  const { hardware, legacyHardware, kernel } = presets;
  return { hardware: includeLegacy ? [...hardware, ...legacyHardware] : hardware, kernel };
}

function choicesFor(profile) {
  const { platform, fingerprintMode } = profile;
  return ['hardware', 'kernel'].includes(fingerprintMode) ? userAgentPresets(platform)[fingerprintMode] : [];
}

function currentUserAgents(profile) {
  const version = profile.fingerprintMode === 'kernel' ? require('./nativecore').BUILD : CHROMIUM_VERSION;
  const major = version.split('.')[0];
  const agent = profile.fingerprintMode === 'kernel' ? 'Firefox' : 'Chrome';
  return choicesFor(profile).filter(([, value]) => value.includes(`${agent}/${major}.`));
}

function resolveUserAgent(profile, choice, previousUserAgent) {
  if (choice !== 'random') return choice === '' ? null : choice ?? null;
  const choices = currentUserAgents(profile);
  if (!choices.length) return null;
  const candidates = choices.length > 1 ? choices.filter(([, value]) => value !== previousUserAgent) : choices;
  return candidates[crypto.randomInt(candidates.length)][1];
}

function isUserAgentAllowed(profile) {
  return profile.userAgent == null || profile.userAgent === '' || choicesFor(profile).some(([, value]) => value === profile.userAgent);
}

module.exports = { userAgentPresets, currentUserAgents, resolveUserAgent, isUserAgentAllowed };
