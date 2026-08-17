/**
 * Draft event vocabulary.
 *
 * Everything the extension knows about a draft is expressed as an append-only
 * sequence of these events. All UI state is a pure function of the log
 * (see reducer.js), which is what makes replay, undo and crash-recovery work.
 *
 * Events are plain JSON so they can cross the content-script -> background
 * boundary and be persisted verbatim.
 */

export const EventType = {
  /** League settings established or changed. Payload: LeagueConfig. */
  LEAGUE_CONFIGURED: 'LEAGUE_CONFIGURED',
  /** A team roster slot was seeded from the draft room (keepers, prior picks). */
  TEAM_REGISTERED: 'TEAM_REGISTERED',
  /** A player was put up for bid. */
  NOMINATION: 'NOMINATION',
  /** The high bid on the active nomination changed. */
  BID: 'BID',
  /** A player was won. This is the only event that mutates rosters/budgets. */
  SOLD: 'SOLD',
  /** The active nomination was withdrawn without a sale (rare, platform-specific). */
  NOMINATION_CANCELLED: 'NOMINATION_CANCELLED',
  /** Operator correction of an earlier event (bad parse, OCR slip). */
  CORRECTION: 'CORRECTION',
  /** An earlier event is retracted. Payload: { targetId }. */
  RETRACTION: 'RETRACTION',
  /** Valuations (re)loaded from CSV. Payload: { source, count }. */
  VALUATIONS_LOADED: 'VALUATIONS_LOADED',
  /** Draft finished. */
  DRAFT_COMPLETE: 'DRAFT_COMPLETE',
};

/** Events that a RETRACTION is allowed to target. */
const RETRACTABLE = new Set([
  EventType.SOLD,
  EventType.NOMINATION,
  EventType.BID,
  EventType.TEAM_REGISTERED,
]);

let seq = 0;

/**
 * Build a well-formed event. `id` is monotonic within a session; `ts` is the
 * wall-clock time the extension observed it (not necessarily the server's).
 */
export function makeEvent(type, payload, meta = {}) {
  if (!Object.hasOwn(EventType, type)) {
    throw new Error(`unknown event type: ${type}`);
  }
  return {
    id: meta.id ?? `e${++seq}`,
    type,
    ts: meta.ts ?? Date.now(),
    // Which layer produced this: 'ws' | 'dom' | 'ocr' | 'manual' | 'replay'.
    source: meta.source ?? 'manual',
    // 0..1. DOM/OCR adapters report lower confidence; the UI flags anything
    // below `reviewThreshold` for operator confirmation.
    confidence: meta.confidence ?? 1,
    payload,
  };
}

export function isRetractable(event) {
  return RETRACTABLE.has(event.type);
}

/**
 * Validate an event's payload shape. Returns an array of problems; empty means
 * valid. Adapters run this before emitting so a bad selector surfaces as a
 * loud parse error rather than silently poisoning the log.
 */
export function validate(event) {
  const problems = [];
  const p = event.payload ?? {};

  const needString = (field) => {
    if (typeof p[field] !== 'string' || p[field].length === 0) {
      problems.push(`${event.type}.${field} must be a non-empty string`);
    }
  };
  const needMoney = (field) => {
    if (!Number.isFinite(p[field]) || p[field] < 0) {
      problems.push(`${event.type}.${field} must be a non-negative number`);
    }
  };

  switch (event.type) {
    case EventType.LEAGUE_CONFIGURED:
      needMoney('budget');
      if (!Number.isInteger(p.numTeams) || p.numTeams < 2) {
        problems.push('LEAGUE_CONFIGURED.numTeams must be an integer >= 2');
      }
      if (!Array.isArray(p.rosterSlots) || p.rosterSlots.length === 0) {
        problems.push('LEAGUE_CONFIGURED.rosterSlots must be a non-empty array');
      }
      break;

    case EventType.TEAM_REGISTERED:
      needString('teamId');
      needString('teamName');
      break;

    case EventType.NOMINATION:
      needString('playerName');
      needString('position');
      break;

    case EventType.BID:
      needMoney('amount');
      needString('teamId');
      break;

    case EventType.SOLD:
      needString('playerName');
      needString('position');
      needString('teamId');
      needMoney('price');
      break;

    case EventType.RETRACTION:
      needString('targetId');
      break;

    default:
      break;
  }

  return problems;
}
