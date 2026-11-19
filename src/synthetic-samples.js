'use strict';
const { createHash } = require('node:crypto');

const SAMPLE_VERSION = 'cike-synthetic-samples-v1';

function seedFor(profileId, label) {
  return createHash('sha256').update(JSON.stringify([SAMPLE_VERSION, profileId, label])).digest();
}

function fictionalNames(seed, kind) {
  return Array.from({ length: 3 }, (_, index) => {
    const suffix = seed.subarray(index * 4, (index + 1) * 4).toString('hex').toUpperCase();
    return `CIKE QA ${kind} ${suffix}`;
  });
}

function rectangles(seed) {
  const quarterPixels = (offset, min, max) => (min + seed.readUInt16LE(offset) % (max - min + 1)) / 4;
  return Array.from({ length: 3 }, (_, index) => {
    const offset = index * 8;
    return [
      quarterPixels(offset, 0, 1280),
      quarterPixels(offset + 2, 0, 960),
      quarterPixels(offset + 4, 320, 2080),
      quarterPixels(offset + 6, 64, 480),
    ];
  });
}

function sampleRecord(label, data, value) {
  const digest = createHash('sha256').update(JSON.stringify([label, data])).digest('hex').slice(0, 16).toUpperCase();
  return { label, value, digest };
}

function syntheticSamples(profileId) {
  const plugins = fictionalNames(seedFor(profileId, 'PLUGINS'), '虚构插件');
  const rects = rectangles(seedFor(profileId, 'RECTS'));
  const fonts = fictionalNames(seedFor(profileId, 'FONTS'), '虚构字体');
  const audioSeed = seedFor(profileId, 'AUDIO');
  const pcm = Array.from({ length: 12 }, (_, index) => audioSeed.readInt16LE(index * 2));

  return [
    sampleRecord('PLUGINS', plugins, plugins.join('、')),
    sampleRecord('RECTS', rects, rects.map(([x, y, width, height]) => `(${x}, ${y}, ${width}, ${height})`).join(' · ')),
    sampleRecord('FONTS', fonts, fonts.join('、')),
    sampleRecord('AUDIO', pcm, `PCM 16 位 [${pcm.join(', ')}]`),
  ];
}

module.exports = { syntheticSamples };
