'use strict';
const { createHash } = require('node:crypto');
const { syntheticSamples } = require('./synthetic-samples');

function comparisonKey(id) {
  return createHash('sha256').update(JSON.stringify(['cike-synthetic-comparison-v1', id])).digest('hex').slice(0, 32);
}

function comparisonRows(leftId, rightId) {
  const rightSamples = syntheticSamples(rightId);
  return syntheticSamples(leftId).map(({ label, digest }, index) => {
    const right = rightSamples[index].digest;
    return { label, left: digest, right, same: digest === right };
  });
}

function syntheticComparison(profiles, currentId, params) {
  const entries = new Map();
  for (const { id, sequence, name, deleting } of profiles) {
    if (deleting || typeof id !== 'string' || !id) continue;
    const key = comparisonKey(id);
    if (entries.has(key)) continue;
    const number = `#${sequence}`;
    const label = name && String(name) !== String(sequence) ? `${number} · ${name}` : number;
    entries.set(key, { id, option: { key, label } });
  }

  const available = [...entries.values()];
  const firstOther = excluded => available.find(entry => entry !== excluded);
  const current = entries.get(comparisonKey(currentId));
  const leftKeys = params.getAll('left');
  const rightKeys = params.getAll('right');
  const submitted = leftKeys.length > 0 || rightKeys.length > 0;
  const requestedLeft = leftKeys.length === 1 ? entries.get(leftKeys[0]) : undefined;
  const requestedRight = rightKeys.length === 1 ? entries.get(rightKeys[0]) : undefined;
  const defaultLeft = current && current !== requestedRight ? current : firstOther(requestedRight);
  const left = requestedLeft || defaultLeft;
  const right = requestedRight && requestedRight !== left ? requestedRight : firstOther(left);

  let error = null;
  if (submitted) {
    if (!requestedLeft || !requestedRight) error = '所选环境已不存在或无法比较，请重新选择。';
    else if (requestedLeft === requestedRight) error = '请选择两个不同的环境。';
  }

  return {
    options: available.map(entry => entry.option),
    left: left?.option ?? null,
    right: right?.option ?? null,
    error,
    rows: submitted && !error ? comparisonRows(left.id, right.id) : null,
  };
}

module.exports = { syntheticComparison };
