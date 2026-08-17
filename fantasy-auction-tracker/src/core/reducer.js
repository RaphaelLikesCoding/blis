/**
 * log -> state.
 *
 * Pure and total: given the same event array you always get the same state.
 * No I/O, no clocks, no randomness. That property is what lets us replay a
 * recorded draft in tests and rebuild after a mid-draft page refresh.
 */

import { EventType } from './events.js';
import { DEFAULT_CONFIG, slotAccepts, rosterSize } from './config.js';
import { playerKey, normalizePosition } from './players.js';

function emptyTeam(teamId, teamName, config) {
  return {
    teamId,
    teamName,
    spent: 0,
    roster: [], // { playerKey, name, position, price, slot }
    slots: config.rosterSlots.map((type) => ({ type, filled: null })),
  };
}

/**
 * Place a player into the tightest-fitting open slot: dedicated position slot
 * first, then flex, then bench. Greedy, but assignment only affects the
 * "needs" display -- budget math depends on the open-slot count, which is
 * assignment-independent.
 */
function assignSlot(team, position) {
  const pos = normalizePosition(position);
  const open = team.slots.filter((s) => !s.filled);
  const rank = (slot) =>
    slot.type === 'BN' ? 2 : (slot.type === 'FLEX' || slot.type === 'SUPERFLEX' || slot.type === 'WRRB' || slot.type === 'OP') ? 1 : 0;
  const fits = open.filter((s) => slotAccepts(s.type, pos)).sort((a, b) => rank(a) - rank(b));
  return fits[0] ?? null;
}

export function initialState(config = DEFAULT_CONFIG) {
  return {
    config: { ...config },
    teams: new Map(),
    /** playerKey -> { name, position, teamId, price, eventId } */
    drafted: new Map(),
    /** Currently on the block, or null. */
    nomination: null,
    /** Chronological sale history, for the ticker and post-mortem. */
    history: [],
    /** Events the adapter was unsure about; the UI asks you to confirm these. */
    needsReview: [],
    /** Retracted event ids, applied before anything else. */
    retracted: new Set(),
    complete: false,
    /** Non-fatal problems, surfaced in the UI so silence never means "fine". */
    warnings: [],
  };
}

function ensureTeam(state, teamId, teamName) {
  if (!state.teams.has(teamId)) {
    state.teams.set(teamId, emptyTeam(teamId, teamName ?? teamId, state.config));
  } else if (teamName) {
    state.teams.get(teamId).teamName = teamName;
  }
  return state.teams.get(teamId);
}

function applySold(state, event) {
  const p = event.payload;
  const key = playerKey(p.playerName, p.position);

  if (state.drafted.has(key)) {
    state.warnings.push({
      eventId: event.id,
      message: `duplicate sale for ${p.playerName}; ignoring the later one`,
    });
    return;
  }

  const team = ensureTeam(state, p.teamId, p.teamName);
  const slot = assignSlot(team, p.position);
  if (!slot) {
    state.warnings.push({
      eventId: event.id,
      message: `${team.teamName} has no open slot for ${p.playerName} (${p.position})`,
    });
  } else {
    slot.filled = key;
  }

  const record = {
    playerKey: key,
    name: p.playerName,
    position: normalizePosition(p.position),
    nflTeam: p.nflTeam ?? null,
    teamId: p.teamId,
    price: p.price,
    slot: slot?.type ?? null,
    eventId: event.id,
    ts: event.ts,
  };

  team.spent += p.price;
  team.roster.push(record);
  state.drafted.set(key, record);
  state.history.push(record);

  if (state.nomination && state.nomination.playerKey === key) {
    state.nomination = null;
  }
}

/**
 * Fold events into state.
 *
 * @param {Array} log - append-only event array
 * @param {object} [opts]
 * @param {object} [opts.config] - starting config; LEAGUE_CONFIGURED overrides
 */
export function reduce(log, opts = {}) {
  const baseConfig = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
  const state = initialState(baseConfig);

  // Retractions are resolved up front so an event is never applied and then
  // un-applied -- rewinding budget/slot side effects correctly is fiddly and
  // easy to get subtly wrong.
  for (const e of log) {
    if (e.type === EventType.RETRACTION) state.retracted.add(e.payload.targetId);
  }

  const corrections = new Map();
  for (const e of log) {
    if (e.type === EventType.CORRECTION) corrections.set(e.payload.targetId, e.payload.patch);
  }

  for (const raw of log) {
    if (state.retracted.has(raw.id)) continue;
    if (raw.type === EventType.RETRACTION || raw.type === EventType.CORRECTION) continue;

    const patch = corrections.get(raw.id);
    const event = patch ? { ...raw, payload: { ...raw.payload, ...patch }, confidence: 1 } : raw;

    if (event.confidence < state.config.reviewThreshold) {
      state.needsReview.push(event);
      continue;
    }

    switch (event.type) {
      case EventType.LEAGUE_CONFIGURED:
        Object.assign(state.config, event.payload);
        // Resize existing teams' slot arrays to the new roster shape.
        for (const team of state.teams.values()) {
          const filled = team.slots.filter((s) => s.filled);
          team.slots = state.config.rosterSlots.map((type) => ({ type, filled: null }));
          for (const old of filled) {
            const target = team.slots.find((s) => !s.filled && s.type === old.type)
              ?? team.slots.find((s) => !s.filled);
            if (target) target.filled = old.filled;
          }
        }
        break;

      case EventType.TEAM_REGISTERED:
        ensureTeam(state, event.payload.teamId, event.payload.teamName);
        break;

      case EventType.NOMINATION:
        state.nomination = {
          playerKey: playerKey(event.payload.playerName, event.payload.position),
          name: event.payload.playerName,
          position: normalizePosition(event.payload.position),
          nflTeam: event.payload.nflTeam ?? null,
          highBid: event.payload.openingBid ?? state.config.minBid,
          highBidder: event.payload.nominatingTeamId ?? null,
          startedAt: event.ts,
        };
        break;

      case EventType.BID:
        if (state.nomination) {
          // Bids can arrive out of order over a lossy DOM observer; never let
          // the high bid move backwards.
          if (event.payload.amount >= state.nomination.highBid) {
            state.nomination.highBid = event.payload.amount;
            state.nomination.highBidder = event.payload.teamId;
          }
        }
        break;

      case EventType.SOLD:
        applySold(state, event);
        break;

      case EventType.NOMINATION_CANCELLED:
        state.nomination = null;
        break;

      case EventType.DRAFT_COMPLETE:
        state.complete = true;
        break;

      default:
        break;
    }
  }

  return state;
}

/** Derived per-team figures used everywhere in the UI and analytics. */
export function teamSummary(team, config) {
  const size = rosterSize(config);
  const filled = team.roster.length;
  const openSlots = Math.max(0, size - filled);
  const remaining = config.budget - team.spent;
  // Must reserve the minimum bid for every slot after the one being bid on.
  const maxBid = openSlots === 0
    ? 0
    : Math.max(0, remaining - (openSlots - 1) * config.minBid);

  const needs = {};
  for (const slot of team.slots) {
    if (slot.filled || slot.type === 'IR') continue;
    needs[slot.type] = (needs[slot.type] ?? 0) + 1;
  }

  return {
    ...team,
    openSlots,
    remaining,
    maxBid,
    needs,
    avgPerSlot: openSlots ? remaining / openSlots : 0,
  };
}

export function allTeamSummaries(state) {
  return [...state.teams.values()].map((t) => teamSummary(t, state.config));
}
