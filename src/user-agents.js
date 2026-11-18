'use strict';
const crypto = require('crypto');
const catalog = require('./user-agents.json');

function userAgentPresets(platform) {
  return typeof platform === 'string' && Object.hasOwn(catalog, platform) ? catalog[platform] : { hardware: [], kernel: [] };
}

function choicesFor(profile) {
  const { platform, fingerprintMode } = profile;
  return ['hardware', 'kernel'].includes(fingerprintMode) ? userAgentPresets(platform)[fingerprintMode] : [];
}

function resolveUserAgent(profile, choice) {
  if (choice !== 'random') return choice === '' ? null : choice ?? null;
  const choices = choicesFor(profile);
  return choices.length ? choices[crypto.randomInt(choices.length)][1] : null;
}

function isUserAgentAllowed(profile) {
  return profile.userAgent == null || profile.userAgent === '' || choicesFor(profile).some(([, value]) => value === profile.userAgent);
}

module.exports = { userAgentPresets, resolveUserAgent, isUserAgentAllowed };
