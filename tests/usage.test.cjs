const { test } = require('node:test');
const assert = require('node:assert/strict');
const { usageUrlFor, sameUsageAccount, readUsageHtml } = require('../usage.js');

const origin = 'https://gemini.google.com';
const reset = '2026-11-26T08:56:00Z';
const pool = (poolType, percentageUsed) => ({ poolType, percentageUsed, gxu: { windowRefreshesAt: reset } });
const payload = { data: { viewer: { rpcs: { getUsageInfo: { pools: [
  pool('GXU_WEEKLY', 0.035), pool('OTHER', 1), pool('GXU_FIVE_HOURLY', 0.229),
] } } } } };
const result = { current: { used: 23, resetsAt: Date.parse(reset) }, weekly: { used: 4, resetsAt: Date.parse(reset) } };
const script = (...events) => `<script type="application/json" data-bg3-relay-preload>${JSON.stringify({ events })}</script>`;

test('targets only Gemini chat routes and keeps explicit account selection', () => {
  assert.equal(usageUrlFor(`${origin}/app/abc?utm_source=x`).href, `${origin}/usage`);
  assert.equal(usageUrlFor(`${origin}/u/2/app/abc`).href, `${origin}/u/2/usage`);
  assert.equal(usageUrlFor(`${origin}/?authuser=3`).href, `${origin}/usage?authuser=3`);
  assert.equal(usageUrlFor(`${origin}/usage`), null);
  assert.equal(usageUrlFor(`${origin}/settings`), null);
  assert.equal(usageUrlFor('https://example.com/app'), null);
});

test('rejects unrelated redirects and mismatched explicit account routes', () => {
  assert.equal(sameUsageAccount(`${origin}/usage`, `${origin}/u/0/usage`), true);
  assert.equal(sameUsageAccount(`${origin}/usage?authuser=2`, `${origin}/u/2/usage`), true);
  assert.equal(sameUsageAccount(`${origin}/usage?authuser=2`, `${origin}/u/0/usage`), false);
  assert.equal(sameUsageAccount(`${origin}/usage`, 'https://accounts.google.com/usage'), false);
});

test('extracts the two official pools from a direct preload result', () => {
  assert.deepEqual(readUsageHtml(script({ id: 'use', kind: 'next', payload })), result);
});

test('reassembles the prefixed stream across preload script tags and ignores other queries', () => {
  const raw = `)]}'\n${JSON.stringify([payload, { hasNext: false }])}`;
  const html = script({ id: 'use', kind: 'chunk', chunk: raw.slice(0, 120) })
    + script({ id: 'other', kind: 'chunk', chunk: '[{}]' })
    + script({ id: 'use', kind: 'chunk', chunk: raw.slice(120) }, { id: 'use', kind: 'complete' });
  assert.deepEqual(readUsageHtml(html), result);
});

test('does not treat a login page, failed stream, invalid pool or executable script as data', () => {
  assert.equal(readUsageHtml('<html>Sign in</html>'), null);
  assert.equal(readUsageHtml(`<script>${JSON.stringify(payload)}</script>`), null);
  assert.equal(readUsageHtml(script({ id: 'use', kind: 'chunk', chunk: JSON.stringify(payload) }, { id: 'use', kind: 'error' })), null);
  const invalid = JSON.parse(JSON.stringify(payload));
  invalid.data.viewer.rpcs.getUsageInfo.pools[0].gxu.windowRefreshesAt = 'invalid';
  assert.equal(readUsageHtml(script({ id: 'use', kind: 'next', payload: invalid })), null);
});
