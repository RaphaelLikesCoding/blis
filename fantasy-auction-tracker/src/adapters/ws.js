/**
 * WebSocket adapter.
 *
 * Consumes frames mirrored out of the page by content/inject.js. Because the
 * on-the-wire schema differs per platform (and is undocumented), this works in
 * two modes:
 *
 *   RECORD  - no mapping configured yet. Frames are stored raw so you can run
 *             a mock draft, export the capture, and derive an exact mapping.
 *             This is the intended first run against any new platform.
 *   MAP     - a mapping is configured. Frames are translated into draft events
 *             with full confidence.
 *
 * The heuristic sniffer in `guessMapping` is a convenience for building that
 * mapping from a capture; it is not trusted to run unattended, because a
 * wrongly-guessed price field is worse than no data at all.
 */

import { EventType, makeEvent } from '../core/events.js';
import { Adapter, Strategy } from './base.js';

/** Read a dotted path, tolerating arrays: 'payload.player.name'. */
export function get(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return Array.isArray(acc) && /^\d+$/.test(key) ? acc[Number(key)] : acc[key];
  }, obj);
}

/**
 * A mapping describes how to read one platform's frames.
 *
 * {
 *   typePath: 'type',
 *   types: { nomination: ['NOMINATE'], bid: ['BID'], sold: ['SOLD','WON'] },
 *   paths: {
 *     playerName: 'player.fullName',
 *     position: 'player.position',
 *     nflTeam: 'player.proTeam',
 *     teamId: 'teamId',
 *     amount: 'amount',
 *   },
 * }
 */
export class WebSocketAdapter extends Adapter {
  constructor(emit, options = {}) {
    super(emit, options);
    this.strategy = Strategy.WS;
    this.mapping = options.mapping ?? null;
    this.hints = options.wsHints ?? { urlContains: [] };
    /** Raw capture, used in RECORD mode and for post-draft debugging. */
    this.capture = [];
    this.maxCapture = options.maxCapture ?? 5000;
    this.onFrame = options.onFrame ?? null;
  }

  static get id() { return 'ws'; }

  get mode() { return this.mapping ? 'MAP' : 'RECORD'; }

  /** Is this socket plausibly the draft feed rather than ads/telemetry? */
  relevant(url) {
    const hints = this.hints.urlContains ?? [];
    if (!hints.length) return true;
    return hints.some((h) => url.includes(h));
  }

  handleFrame({ url, body }) {
    if (!this.relevant(url)) return;

    let parsed;
    try { parsed = JSON.parse(body); } catch { return; }

    if (this.capture.length < this.maxCapture) {
      this.capture.push({ url, body });
    }
    this.onFrame?.({ url, parsed });

    if (!this.mapping) return; // RECORD mode: observe only.

    // Frames often batch several updates.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) this.translate(item);
  }

  translate(msg) {
    const { typePath, types, paths } = this.mapping;
    const rawType = String(get(msg, typePath) ?? '').toUpperCase();
    if (!rawType) return;

    const matches = (names) => (names ?? []).some((n) => rawType.includes(n.toUpperCase()));
    const conf = this.confidenceFor(Strategy.WS);

    const playerName = get(msg, paths.playerName);
    const position = get(msg, paths.position);
    const teamId = get(msg, paths.teamId);
    const amount = Number(get(msg, paths.amount));

    if (matches(types.sold)) {
      if (!playerName || !teamId || !Number.isFinite(amount)) return;
      this.emit(makeEvent(EventType.SOLD, {
        playerName: String(playerName),
        position: String(position ?? 'UNK'),
        nflTeam: get(msg, paths.nflTeam) ?? null,
        teamId: String(teamId),
        teamName: String(get(msg, paths.teamName) ?? teamId),
        price: amount,
      }, { source: 'ws', confidence: conf }));
      return;
    }

    if (matches(types.nomination)) {
      if (!playerName) return;
      this.emit(makeEvent(EventType.NOMINATION, {
        playerName: String(playerName),
        position: String(position ?? 'UNK'),
        nflTeam: get(msg, paths.nflTeam) ?? null,
        openingBid: Number.isFinite(amount) ? amount : undefined,
        nominatingTeamId: teamId != null ? String(teamId) : undefined,
      }, { source: 'ws', confidence: conf }));
      return;
    }

    if (matches(types.bid)) {
      if (!Number.isFinite(amount) || teamId == null) return;
      this.emit(makeEvent(EventType.BID, {
        amount, teamId: String(teamId),
      }, { source: 'ws', confidence: conf }));
    }
  }

  exportCapture() {
    return { version: 1, frames: this.capture };
  }

  async start() {
    // Frames are pushed in by content.js; nothing to poll.
  }
}

/**
 * Suggest a mapping from a recorded capture.
 *
 * Scores candidate paths by how well they behave like the field in question:
 * a price field is a small positive integer that changes often; a player name
 * is a two-word string; a type field is a short repeated enum. Output is a
 * starting point for a human to confirm, never something to ship unreviewed.
 */
export function guessMapping(frames) {
  const paths = new Map(); // path -> { values:Set, samples:[] }

  const walk = (obj, prefix = '') => {
    if (obj == null || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') {
        walk(value, path);
      } else {
        if (!paths.has(path)) paths.set(path, { values: new Set(), samples: [] });
        const entry = paths.get(path);
        entry.values.add(value);
        if (entry.samples.length < 20) entry.samples.push(value);
      }
    }
  };

  for (const frame of frames) {
    try { walk(JSON.parse(frame.body ?? frame)); } catch { /* skip */ }
  }

  const score = (predicate) => [...paths.entries()]
    .map(([path, entry]) => ({ path, entry, score: predicate(entry, path) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const isEnum = (e, path) => {
    const strings = [...e.values].filter((v) => typeof v === 'string');
    if (strings.length !== e.values.size || e.values.size === 0) return 0;
    const short = strings.every((s) => s.length <= 32 && !s.includes(' '));
    const repeated = e.samples.length > e.values.size;
    return (short ? 2 : 0) + (repeated ? 2 : 0) + (/type|event|action|kind/i.test(path) ? 3 : 0);
  };

  const isName = (e, path) => {
    const strings = [...e.values].filter((v) => typeof v === 'string');
    if (!strings.length) return 0;
    const nameish = strings.filter((s) => /^[A-Z][a-z'’.-]+ [A-Z]/.test(s)).length / strings.length;
    return nameish * 5 + (/name|player|full/i.test(path) ? 3 : 0);
  };

  const isMoney = (e, path) => {
    const nums = [...e.values].filter((v) => typeof v === 'number');
    if (nums.length !== e.values.size || !nums.length) return 0;
    const plausible = nums.filter((n) => Number.isInteger(n) && n >= 0 && n <= 400).length / nums.length;
    return plausible * 4 + (/amount|bid|price|cost|value|salary/i.test(path) ? 3 : 0);
  };

  const isPosition = (e) => {
    const strings = [...e.values].filter((v) => typeof v === 'string');
    if (!strings.length) return 0;
    const posish = strings.filter((s) => /^(QB|RB|WR|TE|K|DEF|DST|D\/ST)$/i.test(s.trim())).length;
    return (posish / strings.length) * 10;
  };

  const isTeamId = (e, path) => (/team|owner|franchise|roster/i.test(path) && e.values.size <= 32 ? 4 : 0);

  const top = (list) => list[0]?.path ?? null;

  return {
    typePath: top(score(isEnum)),
    types: {
      nomination: ['NOMINAT'],
      bid: ['BID'],
      sold: ['SOLD', 'WON', 'COMPLETE'],
    },
    paths: {
      playerName: top(score(isName)),
      position: top(score(isPosition)),
      teamId: top(score(isTeamId)),
      amount: top(score(isMoney)),
    },
    candidates: {
      type: score(isEnum).slice(0, 5).map((c) => c.path),
      playerName: score(isName).slice(0, 5).map((c) => c.path),
      position: score(isPosition).slice(0, 5).map((c) => c.path),
      teamId: score(isTeamId).slice(0, 5).map((c) => c.path),
      amount: score(isMoney).slice(0, 5).map((c) => c.path),
    },
  };
}
