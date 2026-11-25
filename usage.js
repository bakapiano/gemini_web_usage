(() => {
  'use strict';

  const origin = 'https://gemini.google.com';
  const usagePath = /^(?:\/u\/\d+)?\/usage\/?$/;
  const chatPath = /^(?:\/u\/\d+)?(?:\/app(?:\/[^/]+)?\/?)?\/?$/;

  function usageUrlFor(href) {
    const url = new URL(href);
    if (url.origin !== origin || !chatPath.test(url.pathname)) return null;
    const prefix = url.pathname.match(/^\/u\/\d+(?=\/|$)/)?.[0] ?? '';
    const usage = new URL(`${prefix}/usage`, origin);
    const account = url.searchParams.get('authuser');
    if (account && /^\d+$/.test(account)) usage.searchParams.set('authuser', account);
    return usage;
  }

  function isUsageUrl(href) {
    const url = new URL(href);
    return url.origin === origin && usagePath.test(url.pathname);
  }

  function sameUsageAccount(requested, received) {
    if (!isUsageUrl(received)) return false;
    const account = href => {
      const url = new URL(href);
      return url.pathname.match(/^\/u\/(\d+)(?=\/|$)/)?.[1]
        ?? url.searchParams.get('authuser');
    };
    const expected = account(requested);
    return expected === null || expected === account(received);
  }

  function readPool(pool) {
    const used = pool?.percentageUsed;
    const resetsAt = Date.parse(pool?.gxu?.windowRefreshesAt);
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(resetsAt)) return null;
    return { used: Math.round(used * 100), resetsAt };
  }

  function readPayload(payload) {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const result = readPayload(item);
        if (result) return result;
      }
      return null;
    }
    const pools = payload?.data?.viewer?.rpcs?.getUsageInfo?.pools;
    if (!Array.isArray(pools)) return null;
    const current = readPool(pools.find(pool => pool?.poolType === 'GXU_FIVE_HOURLY'));
    const weekly = readPool(pools.find(pool => pool?.poolType === 'GXU_WEEKLY'));
    return current && weekly ? { current, weekly } : null;
  }

  function readUsageHtml(html) {
    const chunks = new Map();
    // Only process inert, known preload scripts. Never execute the fetched HTML.
    const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    for (const [, attrs, content] of html.matchAll(scripts)) {
      if (!/\sdata-bg3-relay-preload(?=\s|=|$)/i.test(attrs)
          || !/\stype\s*=\s*["']application\/json["']/i.test(attrs)) continue;
      let batch;
      try { batch = JSON.parse(content); } catch { continue; }
      if (!Array.isArray(batch?.events)) continue;
      for (const event of batch.events) {
        if (typeof event?.id !== 'string') continue;
        if (event.kind === 'next') {
          const result = readPayload(event.payload);
          if (result) return result;
        } else if (event.kind === 'chunk' && typeof event.chunk === 'string') {
          chunks.set(event.id, (chunks.get(event.id) ?? '') + event.chunk);
        } else if (event.kind === 'error') {
          chunks.delete(event.id);
        }
      }
    }
    for (const raw of chunks.values()) {
      if (!raw.includes('getUsageInfo')) continue;
      const json = raw.trimStart().replace(/^\)\]\}'[^\S\r\n]*\r?\n/, '');
      try {
        const result = readPayload(JSON.parse(json));
        if (result) return result;
      } catch { /* Ignore an incomplete or changed stream. */ }
    }
    return null;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { usageUrlFor, sameUsageAccount, readUsageHtml };
  } else {
    globalThis.GeminiUsageSidebar = { usageUrlFor, sameUsageAccount, readUsageHtml };
  }
})();
