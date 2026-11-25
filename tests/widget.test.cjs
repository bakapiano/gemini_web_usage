const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const usage = require('../usage.js');

const manifest = require('../manifest.json');
const source = readFileSync(require.resolve(`../${manifest.content_scripts[0].js[1]}`), 'utf8');
const userscriptSource = () => readFileSync(require.resolve('../gemini-web-usage.user.js'), 'utf8');
const key = 'geminiUsageWidgetPosition';
const settle = () => new Promise(resolve => setImmediate(resolve));

function node(tag, namespace) {
  const handlers = new Map();
  const attrs = new Map();
  return {
    tag, namespace, attrs, children: [], style: {}, dataset: {},
    set innerHTML(_) { throw new TypeError('This document requires TrustedHTML assignment'); },
    append(...children) {
      for (const child of children) {
        if (typeof child !== 'string') child.parentNode = this;
        this.children.push(child);
      }
    },
    addEventListener: (type, handler) => handlers.set(type, handler),
    fire: (type, event) => handlers.get(type)?.(event),
    setPointerCapture(id) { this.captured = id; },
    setAttribute: (name, value) => attrs.set(name, value),
    toggleAttribute: (name, value) => value ? attrs.set(name, '') : attrs.delete(name),
  };
}

function allElements(root) {
  return [root, ...root.children.filter(child => typeof child !== 'string').flatMap(allElements)];
}

function fixture(current, weekly) {
  const pool = (poolType, value) => ({ poolType, percentageUsed: value / 100, gxu: { windowRefreshesAt: '2026-11-26T08:56:00Z' } });
  const pools = [pool('GXU_FIVE_HOURLY', current), pool('GXU_WEEKLY', weekly)];
  const payload = { data: { viewer: { rpcs: { getUsageInfo: { pools } } } } };
  const script = JSON.stringify({ events: [{ id: 'usage', kind: 'next', payload }] });
  return `<script type="application/json" data-bg3-relay-preload>${script}</script>`;
}

async function mount({ saved, path = '/app/abc', visible = false, snapshots = [], reducedMotion = false,
  userscript = false, existingWidget = false } = {}) {
  const animations = [];
  const shadow = node('#shadow-root');
  const host = {
    isConnected: false, style: {}, offsetWidth: 220, offsetHeight: 140,
    attachShadow: () => shadow,
    remove() { this.isConnected = false; },
  };
  const calls = [];
  const requests = [];
  const root = { clientWidth: 800, clientHeight: 600 };
  const window = { ...node(), matchMedia: () => ({ matches: reducedMotion }) };
  function createElement(tag) {
    if (tag === 'gemini-usage-widget') return host;
    const element = node(tag);
    element.animate = function (frames, options) {
      let row = this.parentNode;
      while (row && !row.attrs.has('data-pool')) row = row.parentNode;
      const animation = { cancel() { this.cancelled = true; } };
      animations.push({ pool: row?.attrs.get('data-pool'), text: this.textContent, frames, options, animation, badge: this });
      return animation;
    };
    return element;
  }
  const document = { ...node(), hidden: !visible, documentElement: root, createElement,
    createElementNS: (namespace, tag) => node(tag, namespace),
    querySelector: selector => selector === 'gemini-usage-widget' && existingWidget ? {} : null,
    body: { append: element => { element.isConnected = true; } } };
  const location = { href: `https://gemini.google.com${path}` };
  const timers = new Map();
  let now = 0;
  let timerId = 0;
  const platform = userscript ? {
    GM_getValue: name => name === key ? saved : undefined,
    GM_setValue: (name, value) => calls.push({ [name]: value }),
  } : {
    GeminiUsageSidebar: usage,
    chrome: { storage: { local: { get: async () => ({ [key]: saved }), set: async value => calls.push(value) } } },
  };
  vm.runInNewContext(userscript ? userscriptSource() : source, {
    ...platform, window, location, document, AbortController, URL,
    CSSStyleSheet: class { replaceSync(css) { this.css = css; } },
    ResizeObserver: class { observe() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: callback => callback(),
    performance: { now: () => now },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, at: now + delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async url => {
      const sample = snapshots[Math.min(requests.length, snapshots.length - 1)];
      requests.push({ url, at: now });
      return sample ? { ok: true, url, text: async () => fixture(...sample) } : { ok: false, url };
    },
  });
  await settle();
  const elements = allElements(shadow);
  const handle = elements.find(el => el.attrs.get('id') === 'drag');
  const header = elements.find(el => el.tag === 'header');
  const button = elements.find(el => el.attrs.get('id') === 'refresh');
  return { handle, header, button, host, shadow, elements, calls, root, window, location, document, requests, animations,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, { at, callback }] = next;
        now = at;
        timers.delete(id);
        callback();
        await settle();
      }
      now = end;
    },
  };
}

const pointer = (clientX, clientY, pointerId = 1, target = {}) => ({ clientX, clientY, pointerId, isPrimary: true, button: 0, target });

test('starts at the bottom right on chat routes and hides on the usage page', async () => {
  const { host, window, location } = await mount();
  assert.equal(host.isConnected, true);
  assert.deepEqual(host.style, { right: '12px', bottom: '12px' });
  location.href = 'https://gemini.google.com/usage';
  window.fire('popstate');
  assert.equal(host.isConnected, false);
});

test('the header background captures one pointer, clamps to the visible area, and saves after dragging', async () => {
  const { host, header, calls } = await mount();
  header.fire('pointerdown', pointer(600, 460));
  assert.equal(header.captured, 1);
  header.fire('pointermove', pointer(500, 400, 2));
  assert.deepEqual(host.style, { right: '12px', bottom: '12px' });
  header.fire('pointermove', pointer(480, 400));
  assert.deepEqual(host.style, { right: '132px', bottom: '72px' });
  header.fire('pointermove', pointer(-500, -500));
  assert.deepEqual(host.style, { right: '568px', bottom: '448px' });
  assert.equal(calls.length, 0);
  header.fire('pointerup', pointer(-500, -500));
  header.fire('lostpointercapture', pointer(-500, -500));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][key].right, 568);
  assert.equal(calls[0][key].bottom, 448);
});

test('restores the saved position and keeps it visible on resize; Home resets it', async () => {
  const { host, root, window, handle, calls } = await mount({ saved: { right: 300, bottom: 200 } });
  assert.deepEqual(host.style, { right: '300px', bottom: '200px' });
  root.clientWidth = 390;
  root.clientHeight = 250;
  window.fire('resize');
  assert.deepEqual(host.style, { right: '158px', bottom: '98px' });
  handle.fire('keydown', { key: 'Home', preventDefault() {} });
  assert.deepEqual(host.style, { right: '12px', bottom: '12px' });
  assert.equal(calls[0][key], null);
});

test('dragging from the refresh button does not refresh, a separate click does', async () => {
  const { header, button, host, requests, advance } = await mount({ visible: true, snapshots: [[23, 3]] });
  await advance(5_000);
  header.fire('pointerdown', pointer(600, 460, 1, { closest: () => button }));
  assert.equal(button.captured, 1);
  header.fire('pointermove', pointer(540, 410));
  header.fire('pointerup', pointer(540, 410));
  button.fire('click', { detail: 1 });
  assert.equal(requests.length, 1);
  assert.deepEqual(host.style, { right: '72px', bottom: '62px' });
  header.fire('pointerdown', pointer(540, 410, 1, { closest: () => button }));
  header.fire('pointerup', pointer(540, 410));
  button.fire('click', { detail: 1 });
  await settle();
  await advance(30_000);
  assert.deepEqual(requests.map(({ at }) => at), [0, 5_000, 35_000]);
});

test('polls every 30 seconds while visible and refreshes on return if overdue', async () => {
  const widget = await mount({ visible: true, snapshots: [[23, 3]] });
  await widget.advance(29_999);
  assert.equal(widget.requests.length, 1);
  await widget.advance(1);
  assert.equal(widget.requests.length, 2);
  widget.document.hidden = true;
  widget.document.fire('visibilitychange');
  await widget.advance(120_000);
  assert.equal(widget.requests.length, 2);
  widget.document.hidden = false;
  widget.document.fire('visibilitychange');
  await settle();
  assert.deepEqual(widget.requests.map(({ at }) => at), [0, 30_000, 150_000]);
});

test('only changed pools show signed, fading deltas after the first successful reading', async () => {
  const { animations, advance } = await mount({ visible: true, snapshots: [[23, 3], [28, 3], null, [28, 3], [4, 5]] });
  assert.equal(animations.length, 0);
  await advance(30_000);
  assert.deepEqual(animations.map(a => [a.pool, a.text]), [['current', '+5%']]);
  assert.equal(animations[0].frames.at(-1).opacity, 0);
  assert.equal(animations[0].frames.at(-1).transform, 'translateY(-20px)');
  animations[0].animation.onfinish();
  assert.equal(animations[0].badge.textContent, '');
  await advance(60_000);
  assert.equal(animations.length, 1);
  await advance(30_000);
  assert.deepEqual(animations.map(a => [a.pool, a.text]), [['current', '+5%'], ['current', '−24%'], ['weekly', '+2%']]);
});

test('reduced-motion users see a fade without vertical movement', async () => {
  const { animations, advance } = await mount({ visible: true, snapshots: [[23, 3], [27, 3]], reducedMotion: true });
  await advance(30_000);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].frames.every(frame => frame.transform === 'none'), true);
});

test('the standalone userscript polls, animates, and persists position without Chrome APIs', async () => {
  const { host, handle, calls, requests, animations, advance } = await mount({
    userscript: true, saved: { right: 80, bottom: 60 }, visible: true, snapshots: [[23, 3], [28, 4]],
  });
  assert.deepEqual(host.style, { right: '80px', bottom: '60px' });
  handle.fire('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(calls[0][key].right, 90);
  await advance(30_000);
  assert.deepEqual(requests.map(({ at }) => at), [0, 30_000]);
  assert.deepEqual(animations.map(a => [a.pool, a.text]), [['current', '+5%'], ['weekly', '+1%']]);
});

test('the userscript creates and styles its card when Trusted Types blocks innerHTML', async () => {
  const { host, shadow, button, elements, requests } = await mount({ userscript: true, visible: true, snapshots: [[23, 3]] });
  assert.throws(() => { shadow.innerHTML = '<div>rejected</div>'; }, /TrustedHTML/);
  assert.equal(host.isConnected, true);
  assert.match(shadow.adoptedStyleSheets[0].css, /position:fixed/);
  assert.equal(button.children[0].namespace, 'http://www.w3.org/2000/svg');
  assert.equal(elements.find(el => el.attrs.get('id') === 'pools').hidden, false);
  assert.ok(elements.some(el => el.textContent === '23% 已用'));
  assert.ok(elements.some(el => el.textContent === '3% 已用'));
  assert.equal(requests.length, 1);
});

test('a second installation does not mount a duplicate widget or poll', async () => {
  const { host, requests, advance } = await mount({ userscript: true, existingWidget: true, visible: true });
  await advance(60_000);
  assert.equal(host.isConnected, false);
  assert.equal(requests.length, 0);
});
