/**
 * Background event page.
 *
 * Owns the single source of truth: the draft store and the loaded valuations.
 * The content script feeds it events; the sidebar reads snapshots from it.
 * Keeping state here (not in the sidebar or the page) means a draft-room
 * refresh, a sidebar close, or a tab crash loses nothing.
 */

import { DraftStore } from '../core/store.js';
import { EventType } from '../core/events.js';
import { snapshot } from '../core/analytics.js';
import { loadValuations, rescaleToLeague } from '../core/valuations.js';
import { DEFAULT_CONFIG } from '../core/config.js';

const STORAGE_KEY = 'draft:current';

let store = new DraftStore({ config: DEFAULT_CONFIG });
let valuations = [];
let status = { profileId: null, tap: false, lastEventAt: null, source: null };

/** Persist on a timer rather than per-event; a hot auction fires in bursts. */
let saveTimer = null;
function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: store.serialize() });
    } catch (err) {
      console.error('[auction-tracker] persist failed', err);
    }
  }, 500);
}

async function restore() {
  const saved = await browser.storage.local.get([STORAGE_KEY, 'valuationsCsv', 'config']);
  const config = { ...DEFAULT_CONFIG, ...(saved.config ?? {}) };

  if (saved[STORAGE_KEY]?.log?.length) {
    store = DraftStore.deserialize({ config, log: saved[STORAGE_KEY].log });
  } else {
    store = new DraftStore({ config });
  }

  if (saved.valuationsCsv) applyValuations(saved.valuationsCsv, config);
  store.subscribe(() => schedulePersist());
}

function applyValuations(csv, config = store.baseConfig) {
  const { players, problems } = loadValuations(csv);
  valuations = rescaleToLeague(players, config);
  store.emit(EventType.VALUATIONS_LOADED, { source: 'csv', count: players.length });
  return { count: players.length, problems };
}

function currentSnapshot() {
  return {
    ...snapshot(store.state, valuations, {
      aggressiveness: store.baseConfig.aggressiveness ?? 0.5,
    }),
    config: store.baseConfig,
    valuationCount: valuations.length,
    logLength: store.log.length,
    status,
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg?.kind) {
    case 'draft-event': {
      const result = store.append(msg.event);
      if (result.ok) {
        status.lastEventAt = Date.now();
        status.source = msg.event.source;
        broadcast();
      }
      return Promise.resolve(result);
    }

    case 'ws-seen':
      status.tap = true;
      return Promise.resolve({ ok: true });

    case 'adapter-status':
      status.profileId = msg.status;
      status.tabId = sender?.tab?.id ?? null;
      broadcast();
      return Promise.resolve({ ok: true });

    case 'get-snapshot':
      return Promise.resolve(currentSnapshot());

    case 'get-log':
      return Promise.resolve(store.serialize());

    case 'load-valuations': {
      const result = applyValuations(msg.csv);
      browser.storage.local.set({ valuationsCsv: msg.csv });
      broadcast();
      return Promise.resolve(result);
    }

    case 'set-config': {
      const config = { ...store.baseConfig, ...msg.config };
      store.baseConfig = config;
      store.emit(EventType.LEAGUE_CONFIGURED, config, { source: 'manual' });
      // Values are scaled to league size, so a config change invalidates them.
      browser.storage.local.get('valuationsCsv').then(({ valuationsCsv }) => {
        if (valuationsCsv) applyValuations(valuationsCsv, config);
        browser.storage.local.set({ config });
        broadcast();
      });
      return Promise.resolve({ ok: true });
    }

    case 'manual-event': {
      const result = store.emit(msg.type, msg.payload, { source: 'manual' });
      broadcast();
      return Promise.resolve(result);
    }

    case 'retract': {
      const result = store.retract(msg.targetId, msg.reason);
      broadcast();
      return Promise.resolve(result);
    }

    case 'correct': {
      const result = store.correct(msg.targetId, msg.patch);
      broadcast();
      return Promise.resolve(result);
    }

    case 'reset':
      store = new DraftStore({ config: store.baseConfig });
      store.subscribe(() => schedulePersist());
      browser.storage.local.remove(STORAGE_KEY);
      broadcast();
      return Promise.resolve({ ok: true });

    default:
      return undefined;
  }
});

/** Push a fresh snapshot to any open sidebar. */
function broadcast() {
  browser.runtime.sendMessage({ kind: 'snapshot', snapshot: currentSnapshot() })
    .catch(() => { /* no sidebar open */ });
}

restore().catch((err) => console.error('[auction-tracker] restore failed', err));
