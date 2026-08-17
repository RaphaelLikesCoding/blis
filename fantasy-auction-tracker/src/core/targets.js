/**
 * Your target board.
 *
 * Valuations say what a player is worth to the market. Targets say what he is
 * worth *to you* and how badly you want him -- which is a different question,
 * and the one you actually bid off.
 *
 * Two pieces:
 *   tier     - a bucket of interchangeable-to-you players. The point of tiers
 *              is that you need N players from a tier, not one specific name,
 *              so losing one is only a problem when the tier runs dry.
 *   maxPrice - the most you will pay for that player. Explicitly yours, and it
 *              overrides the market-derived ceiling.
 *
 * The number that makes this earn its keep is plan feasibility: whether the
 * targets you still want actually fit in the money you have left. Finding out
 * at $12 remaining that your plan needed $60 is the classic auction death, and
 * it is entirely avoidable.
 */

import { playerKey, normalizePosition, normalizeName } from './players.js';
import { slotAccepts, rosterSize } from './config.js';

/** Normalize one target entry. */
export function makeTarget(entry) {
  const position = normalizePosition(entry.position);
  const name = String(entry.name ?? '').trim();
  return {
    key: playerKey(name, position),
    name,
    position,
    /** 1 is the top tier. Lower number = want more. */
    tier: Number.isFinite(entry.tier) ? Math.max(1, Math.round(entry.tier)) : 1,
    /** Your ceiling. null means "fall back to par value". */
    maxPrice: Number.isFinite(entry.maxPrice) ? entry.maxPrice : null,
    note: entry.note ?? '',
  };
}

/** Normalize and de-duplicate a target list, ordered by tier then price. */
export function buildTargets(entries = []) {
  const seen = new Map();
  for (const raw of entries) {
    const t = makeTarget(raw);
    if (!t.name) continue;
    // A later entry for the same player wins, so editing is idempotent.
    seen.set(t.key, t);
  }
  return [...seen.values()].sort(
    (a, b) => a.tier - b.tier || (b.maxPrice ?? 0) - (a.maxPrice ?? 0) || a.name.localeCompare(b.name),
  );
}

/**
 * Seed a starting board from the valuation CSV.
 *
 * FantasyPros-style exports carry their own tier column; when present it is
 * used directly, otherwise players are cut into `tierCount` bands by value so
 * there is always something to edit rather than an empty screen.
 */
export function seedFromValuations(valuations, { topN = 60, tierCount = 6, positions = null } = {}) {
  const pool = valuations
    .filter((p) => p.value > 0)
    .filter((p) => !positions || positions.includes(p.position))
    .sort((a, b) => b.value - a.value)
    .slice(0, topN);

  const hasTiers = pool.some((p) => Number.isFinite(p.tier));
  const band = Math.max(1, Math.ceil(pool.length / tierCount));

  return buildTargets(pool.map((p, i) => ({
    name: p.name,
    position: p.position,
    tier: hasTiers && Number.isFinite(p.tier) ? p.tier : Math.floor(i / band) + 1,
    maxPrice: Math.round(p.value),
  })));
}

/**
 * The price you are actually willing to pay right now.
 *
 * An explicit maxPrice is yours and is used as written. When `autoAdjust` is
 * on it is scaled by market inflation, because a $40 target in a market
 * running 1.2x is really a $48 target -- holding the nominal number in an
 * inflated market means quietly targeting a worse player.
 */
export function effectivePrice(target, { parValue = null, inflation = 1, autoAdjust = false } = {}) {
  const base = target.maxPrice ?? parValue;
  if (base == null) return null;
  return autoAdjust ? Math.round(base * inflation) : Math.round(base);
}

/**
 * Annotate each target with what happened to it.
 *
 *   open - still available
 *   won  - you got him
 *   lost - somebody else did
 */
export function targetStatus(state, targets, { teamId = null } = {}) {
  const me = teamId ?? state.config.myTeamId;
  return targets.map((t) => {
    const sale = state.drafted.get(t.key);
    if (!sale) return { ...t, status: 'open', wonBy: null, soldFor: null };
    return {
      ...t,
      status: sale.teamId === me ? 'won' : 'lost',
      wonBy: sale.teamId,
      soldFor: sale.price,
      /** Positive means it went for more than you were willing to pay. */
      overshoot: t.maxPrice != null ? sale.price - t.maxPrice : null,
    };
  });
}

/** Per-tier rollup: what is left, what you got, and what it cost. */
export function tierSummary(state, targets, opts = {}) {
  const annotated = targetStatus(state, targets, opts);
  const tiers = new Map();

  for (const t of annotated) {
    if (!tiers.has(t.tier)) {
      tiers.set(t.tier, {
        tier: t.tier, total: 0, open: 0, won: 0, lost: 0,
        openPlayers: [], spent: 0, plannedCost: 0,
      });
    }
    const row = tiers.get(t.tier);
    row.total += 1;
    if (t.status === 'open') {
      row.open += 1;
      row.openPlayers.push(t);
      row.plannedCost += t.maxPrice ?? 0;
    } else if (t.status === 'won') {
      row.won += 1;
      row.spent += t.soldFor ?? 0;
    } else {
      row.lost += 1;
    }
  }

  return [...tiers.values()].sort((a, b) => a.tier - b.tier);
}

/**
 * Can you still afford the targets you have left?
 *
 * Walks your open targets in tier order, assigning each to the tightest open
 * roster slot that accepts him -- the same greedy fit the reducer uses -- and
 * stops when your roster is full. Then compares the cost of that plan against
 * the money you actually have, reserving $1 for every slot the plan does not
 * cover.
 *
 * @returns {{ feasible, plan, plannedCost, budget, shortfall, unslotted, reserve }}
 */
export function planFeasibility(state, targets, { teamId = null, inflation = 1, autoAdjust = false, valuations = [] } = {}) {
  const config = state.config;
  const me = teamId ?? config.myTeamId;
  const team = me ? state.teams.get(me) : null;

  const size = rosterSize(config);
  const filled = team ? team.roster.length : 0;
  const openSlotTypes = team
    ? team.slots.filter((s) => !s.filled).map((s) => s.type)
    : config.rosterSlots.slice();
  const budget = config.budget - (team?.spent ?? 0);
  const openSlots = Math.max(0, size - filled);

  const parFor = new Map(valuations.map((p) => [playerKey(p.name, p.position), p.value]));
  const open = targetStatus(state, targets, { teamId: me }).filter((t) => t.status === 'open');

  const remainingSlots = [...openSlotTypes];
  const plan = [];
  const unslotted = [];

  for (const target of open) {
    // Tightest fit first: a dedicated slot before flex, flex before bench,
    // so a WR does not eat the FLEX that a later RB needs.
    const rank = (slot) => (slot === 'BN' ? 2 : ['FLEX', 'SUPERFLEX', 'WRRB', 'OP'].includes(slot) ? 1 : 0);
    const candidates = remainingSlots
      .map((slot, i) => ({ slot, i }))
      .filter(({ slot }) => slotAccepts(slot, target.position))
      .sort((a, b) => rank(a.slot) - rank(b.slot));

    if (!candidates.length) {
      unslotted.push(target);
      continue;
    }
    const price = effectivePrice(target, {
      parValue: parFor.get(target.key) ?? null, inflation, autoAdjust,
    });
    remainingSlots.splice(candidates[0].i, 1);
    plan.push({ ...target, slot: candidates[0].slot, price: price ?? config.minBid });
  }

  const plannedCost = plan.reduce((s, p) => s + p.price, 0);
  // Slots the plan does not cover still need a body at the minimum bid.
  const reserve = Math.max(0, openSlots - plan.length) * config.minBid;
  const required = plannedCost + reserve;

  return {
    feasible: required <= budget,
    plan,
    plannedCost,
    reserve,
    required,
    budget,
    openSlots,
    shortfall: Math.max(0, required - budget),
    headroom: Math.max(0, budget - required),
    /** Targets with no roster slot left to hold them. */
    unslotted,
  };
}

/**
 * Tier pressure: how close a tier is to running dry relative to how many of
 * its players are still realistically gettable.
 *
 * A tier with two names left and eight rivals who need the position is not two
 * players deep -- it is nearly empty, and that is when you stop being
 * disciplined about a dollar.
 */
export function tierPressure(state, targets, opts = {}) {
  return tierSummary(state, targets, opts).map((row) => ({
    ...row,
    /** 0 = untouched, 1 = every target in this tier is gone. */
    depletion: row.total ? (row.total - row.open) / row.total : 1,
    critical: row.open > 0 && row.open <= 2,
    exhausted: row.open === 0 && row.total > 0,
  }));
}

/** Find a target by the nominated player, if any. */
export function targetFor(targets, key) {
  return targets.find((t) => t.key === key) ?? null;
}

/** Look up by loose name so the sidebar can add "the player on the block". */
export function findByName(targets, name, position) {
  const n = normalizeName(name);
  const pos = normalizePosition(position);
  return targets.find((t) => normalizeName(t.name) === n && (!pos || t.position === pos)) ?? null;
}
