/**
 * The append-only draft log and its derived state.
 *
 * Deliberately dumb: append, recompute, notify. A full re-reduce on every
 * event is O(n) in a log that tops out around a few hundred entries, which is
 * microseconds -- not worth the bug surface of incremental updates.
 */

import { EventType, makeEvent, validate } from './events.js';
import { reduce } from './reducer.js';
import { DEFAULT_CONFIG } from './config.js';

export class DraftStore {
  constructor({ config = DEFAULT_CONFIG, log = [] } = {}) {
    this.baseConfig = { ...DEFAULT_CONFIG, ...config };
    this.log = [...log];
    this.listeners = new Set();
    this.state = reduce(this.log, { config: this.baseConfig });
  }

  /**
   * Append an event. Returns { ok, event, problems }.
   *
   * Rejected events are dropped rather than logged -- a malformed event is an
   * adapter bug, and persisting it would corrupt every future replay.
   */
  append(event) {
    const problems = validate(event);
    if (problems.length) return { ok: false, event, problems };

    if (this.isDuplicate(event)) {
      return { ok: false, event, problems: ['duplicate of a recent event'] };
    }

    this.log.push(event);
    this.recompute();
    return { ok: true, event, problems: [] };
  }

  /**
   * DOM adapters re-emit the same sale on every mutation of the results feed.
   * Suppress a repeat of the same sale, and repeated identical bids inside a
   * short window.
   */
  isDuplicate(event) {
    if (event.type === EventType.SOLD) {
      const key = `${event.payload.playerName}|${event.payload.teamId}|${event.payload.price}`;
      return this.log.some(
        (e) => e.type === EventType.SOLD
          && `${e.payload.playerName}|${e.payload.teamId}|${e.payload.price}` === key,
      );
    }
    if (event.type === EventType.BID) {
      const recent = this.log.at(-1);
      return Boolean(
        recent
          && recent.type === EventType.BID
          && recent.payload.amount === event.payload.amount
          && recent.payload.teamId === event.payload.teamId,
      );
    }
    return false;
  }

  emit(type, payload, meta) {
    return this.append(makeEvent(type, payload, meta));
  }

  /** Retract an earlier event (operator fixing a bad parse). */
  retract(targetId, reason = '') {
    return this.emit(EventType.RETRACTION, { targetId, reason }, { source: 'manual' });
  }

  /** Patch an earlier event's payload in place, e.g. a mis-read price. */
  correct(targetId, patch) {
    return this.emit(EventType.CORRECTION, { targetId, patch }, { source: 'manual' });
  }

  recompute() {
    this.state = reduce(this.log, { config: this.baseConfig });
    for (const fn of this.listeners) fn(this.state, this.log);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.state, this.log);
    return () => this.listeners.delete(fn);
  }

  /** Serializable snapshot for persistence and for exporting a draft. */
  serialize() {
    return { version: 1, config: this.baseConfig, log: this.log };
  }

  static deserialize(data) {
    return new DraftStore({ config: data.config, log: data.log ?? [] });
  }
}
