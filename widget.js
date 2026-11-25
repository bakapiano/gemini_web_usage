(() => {
  'use strict';

  const { usageUrlFor, sameUsageAccount, readUsageHtml } = globalThis.GeminiUsageSidebar;
  const interval = 30_000;
  const inset = 12;
  const poolKeys = ['current', 'weekly'];
  const positionKey = 'geminiUsageWidgetPosition';
  const widgetTag = 'gemini-usage-widget';
  const positionStorage = typeof GM_getValue === 'function' && typeof GM_setValue === 'function'
    ? { read: () => GM_getValue(positionKey), write: value => GM_setValue(positionKey, value) }
    : {
      read: async () => (await chrome.storage.local.get(positionKey))[positionKey],
      write: value => chrome.storage.local.set({ [positionKey]: value }),
    };
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const host = document.createElement(widgetTag);
  const shadow = host.attachShadow({ mode: 'closed' });
  const styles = new CSSStyleSheet();
  styles.replaceSync(`
      :host {
        position:fixed; right:${inset}px; bottom:${inset}px; z-index:1000; display:block;
        width:min(220px, calc(100% - ${inset * 2}px));
        color-scheme:light dark;
        color:light-dark(#202124,#f1f3f4);
        font:12px/1.35 system-ui,sans-serif;
      }
      section {
        box-sizing:border-box; max-height:calc(100dvh - ${inset * 2}px); overflow:auto;
        background:light-dark(#fff,#202124); border:1px solid color-mix(in srgb,currentColor 18%,transparent);
        border-radius:14px; padding:9px 10px; box-shadow:0 4px 18px #0003;
      }
      header, .label { display:flex; align-items:center; justify-content:space-between; gap:6px; }
      header { margin-bottom:5px; cursor:grab; touch-action:none; user-select:none; }
      header[data-dragging], header[data-dragging] button { cursor:grabbing; }
      button, a { font:inherit; color:inherit; }
      button { background:none; border:0; border-radius:6px; padding:2px 4px; cursor:pointer; }
      #drag { flex:1; display:flex; align-items:center; gap:6px; text-align:start; cursor:grab; }
      #refresh { flex:none; display:inline-flex; align-items:center; gap:4px; }
      #refresh svg { width:13px; height:13px; }
      button:hover { background:color-mix(in srgb,currentColor 12%,transparent); }
      button[aria-disabled="true"] { opacity:.55; }
      .row + .row { margin-top:6px; }
      .value { position:relative; }
      .delta {
        position:absolute; inset-inline-end:0; bottom:100%; opacity:0; pointer-events:none; white-space:nowrap;
        border-radius:10px; padding:2px 5px; font-weight:700; line-height:1.15;
        color:light-dark(#923a08,#ffbb96); background:light-dark(#ffeddc,#4b2a1d);
      }
      .delta[data-down] { color:light-dark(#116536,#a5e7b4); background:light-dark(#e4f4e8,#1c3a29); }
      .bar { height:4px; margin:3px 0; border-radius:8px; overflow:hidden; background:color-mix(in srgb,currentColor 15%,transparent); }
      .fill { height:100%; background:#4285f4; }
      .fill[data-near="true"] { background:#e87c36; }
      time, #status { opacity:.78; }
      footer { display:flex; flex-wrap:wrap; justify-content:space-between; gap:4px; margin-top:6px; font-size:11px; }
  `);
  shadow.adoptedStyleSheets = [styles];

  // Gemini enforces Trusted Types in the userscript's execution world. Build
  // actual nodes, including the SVG, without parsing HTML or creating a policy.
  function element(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
    node.append(...children);
    return node;
  }

  function refreshIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    };
    for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M20 4v5h-5m5 0a8 8 0 1 0 .3 5');
    svg.append(path);
    return svg;
  }

  const handle = element('button', {
    id: 'drag', type: 'button', 'aria-label': '移动 Gemini 额度卡片', title: '拖动或用方向键移动；Home 回到右下角',
  }, element('span', { 'aria-hidden': 'true' }, '⠿'), element('strong', null, 'Gemini 额度'));
  const button = element('button', { id: 'refresh', type: 'button', 'aria-label': '刷新 Gemini 额度' }, refreshIcon(), '刷新');
  const header = element('header', null, handle, button);
  const pools = element('div', { id: 'pools', hidden: '' });
  const poolElements = {};
  for (const [key, title] of [['current', '5 小时'], ['weekly', '每周']]) {
    const value = element('strong');
    const badge = element('span', { class: 'delta', 'aria-hidden': 'true' });
    const fill = element('div', { class: 'fill' });
    const time = element('time');
    poolElements[key] = { value, badge, fill, time };
    pools.append(element('div', { class: 'row', 'data-pool': key },
      element('div', { class: 'label' }, element('span', null, title), element('span', { class: 'value' }, value, badge)),
      element('div', { class: 'bar', 'aria-hidden': 'true' }, fill), time));
  }
  const status = element('span', { id: 'status', role: 'status' });
  const link = element('a', { target: '_blank', rel: 'noopener' }, '官方用量页 ↗');
  shadow.append(element('section', { 'aria-label': 'Gemini 使用额度' }, header, pools, element('footer', null, status, link)));
  const activeDeltas = new Map();
  let accountUrl = null;
  let running = null;
  let data = null;
  let updatedAt = 0;
  let attemptedAt = null;
  let autoRefresh = null;
  let failed = false;
  let scheduled = false;
  let position = null;
  let positionChanged = false;
  let drag = null;
  let suppressPointerRefresh = false;

  function bounded({ right, bottom }) {
    const root = document.documentElement;
    return {
      right: Math.max(inset, Math.min(right, root.clientWidth - host.offsetWidth - inset)),
      bottom: Math.max(inset, Math.min(bottom, root.clientHeight - host.offsetHeight - inset)),
    };
  }

  function updatePosition() {
    if (!host.isConnected) return;
    const visible = position ? bounded(position) : { right: inset, bottom: inset };
    host.style.right = `${visible.right}px`;
    host.style.bottom = `${visible.bottom}px`;
  }

  async function savePosition() {
    try {
      await positionStorage.write(position);
    } catch { /* Dragging still works if storage is unavailable. */ }
  }

  async function restorePosition() {
    try {
      const saved = await positionStorage.read();
      if (positionChanged || drag || !Number.isFinite(saved?.right) || !Number.isFinite(saved?.bottom)) return;
      position = saved;
      updatePosition();
    } catch { /* Keep the default position if storage is unavailable. */ }
  }

  function displayedPosition() {
    return {
      right: parseFloat(host.style.right) || inset,
      bottom: parseFloat(host.style.bottom) || inset,
    };
  }

  header.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    suppressPointerRefresh = false;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: displayedPosition(), moved: false };
    // Preserve click targeting for buttons when the pointer hasn't moved.
    const capture = event.target.closest?.('button') ?? header;
    capture.setPointerCapture(event.pointerId);
  });
  header.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = positionChanged = true;
    header.toggleAttribute('data-dragging', true);
    position = bounded({ right: drag.start.right - dx, bottom: drag.start.bottom - dy });
    updatePosition();
  });
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved } = drag;
    drag = null;
    header.toggleAttribute('data-dragging', false);
    if (moved) {
      suppressPointerRefresh = true;
      void savePosition();
    }
  }
  header.addEventListener('pointerup', finishDrag);
  header.addEventListener('pointercancel', finishDrag);
  header.addEventListener('lostpointercapture', finishDrag);
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 40 : 10;
    const next = displayedPosition();
    switch (event.key) {
      case 'ArrowLeft': next.right += step; break;
      case 'ArrowRight': next.right -= step; break;
      case 'ArrowUp': next.bottom += step; break;
      case 'ArrowDown': next.bottom -= step; break;
      case 'Home': break;
      default: return;
    }
    event.preventDefault();
    positionChanged = true;
    position = event.key === 'Home' ? null : bounded(next);
    updatePosition();
    void savePosition();
  });

  function render() {
    pools.hidden = !data;
    button.setAttribute('aria-disabled', String(!!running));
    status.textContent = running ? '正在同步…' : failed
      ? (data ? `刷新失败 · 上次 ${timeFormat.format(updatedAt)}` : '暂时读不到额度')
      : data ? `更新于 ${timeFormat.format(updatedAt)}` : '等待读取…';
    if (!data) return;
    for (const key of poolKeys) {
      const { used, resetsAt } = data[key];
      const { value, fill, time } = poolElements[key];
      value.textContent = `${used}% 已用`;
      fill.style.width = `${Math.min(used, 100)}%`;
      fill.dataset.near = String(used >= 85);
      time.dateTime = new Date(resetsAt).toISOString();
      time.textContent = `重置：${dateFormat.format(resetsAt)}`;
    }
  }

  function animateChanges(previous, next) {
    if (!previous || document.hidden) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const key of poolKeys) {
      const delta = next[key].used - previous[key].used;
      if (!delta) continue;
      const { badge } = poolElements[key];
      activeDeltas.get(key)?.cancel();
      badge.textContent = `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`;
      badge.toggleAttribute('data-down', delta < 0);
      const frames = [
        { opacity: 0, transform: reducedMotion ? 'none' : 'translateY(3px)' },
        { opacity: 1, transform: reducedMotion ? 'none' : 'translateY(-3px)', offset: 0.2 },
        { opacity: 0, transform: reducedMotion ? 'none' : 'translateY(-20px)' },
      ];
      const animation = badge.animate(frames, { duration: 1050, easing: 'ease-out' });
      activeDeltas.set(key, animation);
      animation.onfinish = () => {
        if (activeDeltas.get(key) !== animation) return;
        badge.textContent = '';
        activeDeltas.delete(key);
      };
    }
  }

  function clearAutoRefresh() {
    if (autoRefresh === null) return;
    clearTimeout(autoRefresh);
    autoRefresh = null;
  }

  function canRefresh() {
    return accountUrl && !running && host.isConnected && !document.hidden;
  }

  function scheduleRefresh() {
    if (autoRefresh !== null || !canRefresh()) return;
    const delay = attemptedAt === null ? 0 : interval - (performance.now() - attemptedAt);
    if (delay <= 0) {
      void refresh();
      return;
    }
    autoRefresh = setTimeout(() => {
      autoRefresh = null;
      scheduleRefresh();
    }, delay);
  }

  async function refresh() {
    if (!canRefresh()) return;
    clearAutoRefresh();
    const requested = accountUrl;
    const controller = new AbortController();
    running = controller;
    attemptedAt = performance.now();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const previous = data;
    let succeeded = false;
    render();
    try {
      const response = await fetch(requested, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'text/html' },
        signal: controller.signal,
      });
      if (!response.ok || !sameUsageAccount(requested, response.url)) throw new Error('Usage page unavailable');
      const latest = readUsageHtml(await response.text());
      if (!latest) throw new Error('Usage preload missing');
      if (running === controller) {
        data = latest;
        updatedAt = Date.now();
        failed = false;
        succeeded = true;
      }
    } catch {
      if (running === controller) failed = true;
    } finally {
      clearTimeout(timeout);
      if (running === controller) {
        running = null;
        render();
        scheduleRefresh();
        if (succeeded) animateChanges(previous, data);
      }
    }
  }

  function sync() {
    const target = usageUrlFor(location.href)?.href ?? null;
    if (target !== accountUrl) {
      clearAutoRefresh();
      running?.abort();
      running = null;
      accountUrl = target;
      data = null;
      updatedAt = 0;
      attemptedAt = null;
      failed = false;
      for (const animation of activeDeltas.values()) animation.cancel();
      activeDeltas.clear();
      if (target) link.href = target;
      render();
    }
    if (!target) {
      host.remove();
      return;
    }
    if (!host.isConnected) {
      // Avoid duplicate cards and requests if both installations are enabled.
      if (document.querySelector(widgetTag)) return;
      document.body.append(host);
      updatePosition();
    }
    scheduleRefresh();
  }

  function requestSync() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      sync();
    });
  }

  button.addEventListener('click', event => {
    if (event.detail > 0 && suppressPointerRefresh) return;
    void refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearAutoRefresh();
    else requestSync();
  });
  window.addEventListener('popstate', requestSync);
  window.addEventListener('resize', updatePosition);
  new ResizeObserver(updatePosition).observe(host);
  new MutationObserver(requestSync).observe(document.documentElement, { childList: true, subtree: true });
  sync();
  void restorePosition();
})();
