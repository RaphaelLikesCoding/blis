/**
 * Page-world WebSocket tap.
 *
 * This file runs in the PAGE's JS context, not the content script's isolated
 * world -- that is the only place `window.WebSocket` can be wrapped so the
 * draft app's own socket goes through us. It is loaded as a web-accessible
 * <script> tag by content.js.
 *
 * It is strictly passive: frames are mirrored to the content script via
 * window.postMessage and then handed to the original socket untouched. It
 * never sends, blocks, or alters a frame -- the extension observes the draft,
 * it does not participate in it.
 */

(() => {
  const CHANNEL = '__auction_tracker__';
  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket || NativeWebSocket.__auctionTracked) return;

  const post = (kind, detail) => {
    try {
      window.postMessage({ channel: CHANNEL, kind, detail }, window.location.origin);
    } catch {
      // Frame bodies are occasionally non-cloneable (ArrayBuffer views etc).
      // Losing one frame is acceptable; throwing inside the app is not.
    }
  };

  // Bodies can be large; only forward what is plausibly a draft message and
  // cap the size so a video/telemetry socket cannot flood the pipe.
  const MAX_FRAME = 64 * 1024;

  function summarize(data) {
    if (typeof data === 'string') {
      return data.length > MAX_FRAME ? null : data;
    }
    if (data instanceof ArrayBuffer && data.byteLength <= MAX_FRAME) {
      try { return new TextDecoder().decode(data); } catch { return null; }
    }
    if (ArrayBuffer.isView(data) && data.byteLength <= MAX_FRAME) {
      try { return new TextDecoder().decode(data); } catch { return null; }
    }
    return null;
  }

  const Tracked = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = new target(...args);
      const url = String(args[0] ?? '');
      post('ws-open', { url });

      socket.addEventListener('message', (ev) => {
        const body = summarize(ev.data);
        if (body != null) post('ws-message', { url, body });
      });
      socket.addEventListener('close', () => post('ws-close', { url }));

      return socket;
    },
  });

  Object.defineProperty(Tracked, '__auctionTracked', { value: true });
  window.WebSocket = Tracked;

  // Some rooms poll a JSON endpoint instead of (or alongside) a socket.
  // Mirror fetch responses for URLs that look draft-related.
  const nativeFetch = window.fetch;
  if (nativeFetch && !nativeFetch.__auctionTracked) {
    const tracked = async function fetch(...args) {
      const response = await nativeFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
        if (/draft|auction|nomination|bid/i.test(url)) {
          const clone = response.clone();
          const body = await clone.text();
          if (body.length <= MAX_FRAME) post('http-response', { url, body });
        }
      } catch { /* never let mirroring break the page's own request */ }
      return response;
    };
    Object.defineProperty(tracked, '__auctionTracked', { value: true });
    window.fetch = tracked;
  }

  post('tap-ready', { href: window.location.href });
})();
