/**
 * League configuration and roster-slot logic.
 *
 * Slot eligibility is the piece that makes "which teams can still bid on this
 * player" correct. A team with its RB slots full but a FLEX open is still a
 * live bidder on running backs, and missing that gives you a falsely cheap
 * read on the market.
 */

import { normalizePosition } from './players.js';

/** Which positions each slot type accepts. */
export const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DST: ['DST'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB: ['RB', 'WR'],
  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
  OP: ['QB', 'RB', 'WR', 'TE'],
  BN: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'],
  IR: [],
};

export const DEFAULT_CONFIG = {
  numTeams: 12,
  budget: 200,
  minBid: 1,
  // Expanded to one entry per roster spot.
  rosterSlots: [
    'QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST',
    'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
  ],
  /** Your own team id, once known. Drives the "should I bid" panel. */
  myTeamId: null,
  /** Events below this confidence get flagged for review instead of applied. */
  reviewThreshold: 0.8,
};

/** Expand a compact spec like { QB: 1, RB: 2, BN: 6 } into a slot array. */
export function expandSlots(spec) {
  const out = [];
  for (const [slot, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i += 1) out.push(slot);
  }
  return out;
}

export function slotAccepts(slot, position) {
  return (SLOT_ELIGIBILITY[slot] ?? []).includes(normalizePosition(position));
}

/** Total roster spots per team, excluding IR. */
export function rosterSize(config) {
  return config.rosterSlots.filter((s) => s !== 'IR').length;
}

/**
 * How many teams start a player at each position, counting flex spots by the
 * share of flex-eligible positions. Used to locate replacement level.
 */
export function startersByPosition(config) {
  const counts = Object.fromEntries(
    Object.keys(SLOT_ELIGIBILITY).flatMap((s) => SLOT_ELIGIBILITY[s]).map((p) => [p, 0]),
  );
  for (const slot of config.rosterSlots) {
    if (slot === 'BN' || slot === 'IR') continue;
    const eligible = SLOT_ELIGIBILITY[slot] ?? [];
    if (eligible.length === 1) {
      counts[eligible[0]] += 1;
    } else if (eligible.length > 1) {
      // Flex demand lands mostly on RB/WR in practice; split evenly rather
      // than pretending to know the league's tendencies.
      for (const pos of eligible) counts[pos] += 1 / eligible.length;
    }
  }
  for (const pos of Object.keys(counts)) counts[pos] *= config.numTeams;
  return counts;
}
