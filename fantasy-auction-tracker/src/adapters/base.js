/**
 * Adapter contract.
 *
 * An adapter's only job is to turn "whatever this draft site does" into the
 * event vocabulary in core/events.js. It must never compute analytics, and it
 * must never assume it saw everything -- a missed bid is survivable, a missed
 * or wrong SOLD is not, so sales carry an explicit confidence.
 *
 * Detection strategy, best first:
 *   'ws'  - intercepted WebSocket frames. Structured, exact, instant.
 *   'dom' - MutationObserver over the rendered draft board. Reliable enough,
 *           breaks whenever the site reskins.
 *   'ocr' - last resort for canvas-rendered rooms. Always low confidence.
 */

export const Strategy = { WS: 'ws', DOM: 'dom', OCR: 'ocr' };

/** Confidence floors by strategy; adapters may lower but should not raise. */
export const STRATEGY_CONFIDENCE = {
  [Strategy.WS]: 1.0,
  [Strategy.DOM]: 0.85,
  [Strategy.OCR]: 0.55,
};

export class Adapter {
  /**
   * @param {(event: object) => void} emit - hand a built event to the pipeline
   * @param {object} [options]
   */
  constructor(emit, options = {}) {
    this.emit = emit;
    this.options = options;
    this.strategy = null;
    this.disposers = [];
  }

  /** Human-readable id, e.g. 'nfl'. Overridden by subclasses. */
  static get id() { return 'base'; }

  /** Does this adapter handle the given location? */
  static matches(_url) { return false; }

  /** Begin observing. Subclasses override. */
  async start() { throw new Error('not implemented'); }

  stop() {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose(); } catch { /* teardown must not throw */ }
    }
  }

  track(dispose) { this.disposers.push(dispose); }

  confidenceFor(strategy, penalty = 0) {
    return Math.max(0, (STRATEGY_CONFIDENCE[strategy] ?? 0.5) - penalty);
  }
}

/** Pull the first integer out of a string like "$47" or "Sold for 47". */
export function parseMoney(text) {
  if (text == null) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(text).replace(/,/g, ''));
  return m ? Number(m[0]) : null;
}

/** Debounce noisy DOM callbacks; auctions fire dozens of mutations per bid. */
export function debounce(fn, ms = 120) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/**
 * Observe a subtree and call back on any change. Returns a disposer.
 * Waits for the node to exist, since draft rooms mount asynchronously.
 */
export function observe(root, callback, options = {}) {
  const observer = new MutationObserver(callback);
  observer.observe(root, {
    childList: true, subtree: true, characterData: true, ...options,
  });
  return () => observer.disconnect();
}

/** Poll for a selector to appear, resolving with the node or null on timeout. */
export function waitFor(selector, { timeout = 30000, interval = 250, root = document } = {}) {
  return new Promise((resolve) => {
    const existing = root.querySelector(selector);
    if (existing) return resolve(existing);
    const started = Date.now();
    const timer = setInterval(() => {
      const node = root.querySelector(selector);
      if (node) { clearInterval(timer); resolve(node); }
      else if (Date.now() - started > timeout) { clearInterval(timer); resolve(null); }
    }, interval);
    return undefined;
  });
}
