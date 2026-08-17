/**
 * Content script.
 *
 * Runs in the isolated world on the draft page. Responsibilities:
 *   - inject the page-world WebSocket tap
 *   - relay tapped frames to the WS adapter
 *   - run the DOM adapter as a parallel fallback
 *   - forward every produced event to the background page
 *
 * Both adapters run at once on purpose. The store deduplicates, so the DOM
 * layer silently covers anything the WS mapping misses instead of leaving a
 * hole you only notice after the draft.
 */

(async () => {
  const CHANNEL = '__auction_tracker__';
  const url = (path) => browser.runtime.getURL(path);

  const [{ profileFor }, { GenericDomAdapter }, { WebSocketAdapter }] = await Promise.all([
    import(url('src/adapters/profiles.js')),
    import(url('src/adapters/generic-dom.js')),
    import(url('src/adapters/ws.js')),
  ]);

  const { overrides = {}, mapping = null, enabled = true } =
    await browser.storage.local.get(['overrides', 'mapping', 'enabled']);

  if (enabled === false) return;

  const profile = profileFor(window.location.href, overrides);
  if (!profile) {
    browser.runtime.sendMessage({
      kind: 'adapter-status',
      status: 'no-profile',
      href: window.location.href,
    });
    return;
  }

  const send = (event) => {
    browser.runtime.sendMessage({ kind: 'draft-event', event }).catch(() => {
      // Background may be asleep between events; the next send wakes it.
    });
  };

  // --- WebSocket layer -----------------------------------------------------
  const wsAdapter = new WebSocketAdapter(send, {
    mapping,
    wsHints: profile.wsHints,
    onFrame: ({ url: frameUrl }) => {
      browser.runtime.sendMessage({ kind: 'ws-seen', url: frameUrl }).catch(() => {});
    },
  });
  await wsAdapter.start();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.kind === 'ws-message' || data.kind === 'http-response') {
      wsAdapter.handleFrame(data.detail);
    } else if (data.kind === 'tap-ready') {
      browser.runtime.sendMessage({ kind: 'adapter-status', status: 'tap-ready' }).catch(() => {});
    }
  });

  // Inject into the page world. A <script src> tag is used rather than
  // scripting.executeScript({world:'MAIN'}) so this also works on older
  // Firefox builds where MAIN-world injection is unavailable.
  const tag = document.createElement('script');
  tag.src = url('src/content/inject.js');
  tag.onload = () => tag.remove();
  (document.head ?? document.documentElement).appendChild(tag);

  // --- DOM layer -----------------------------------------------------------
  const domAdapter = new GenericDomAdapter(send, { profile });
  await domAdapter.start();

  // Let the sidebar pull the raw capture for mapping work.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === 'export-capture') {
      return Promise.resolve(wsAdapter.exportCapture());
    }
    if (msg?.kind === 'adapter-info') {
      return Promise.resolve({
        profileId: profile.id,
        wsMode: wsAdapter.mode,
        frames: wsAdapter.capture.length,
        href: window.location.href,
      });
    }
    return undefined;
  });

  window.addEventListener('pagehide', () => {
    domAdapter.stop();
    wsAdapter.stop();
  });
})();
