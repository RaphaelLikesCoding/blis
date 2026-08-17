#!/usr/bin/env node
/**
 * Generate a synthetic auction draft.
 *
 * Draft day happens once and cannot be rehearsed, so the whole pipeline needs
 * something to run against. This produces a full, internally-consistent draft
 * (every team ends at exactly the roster limit and never overspends) plus the
 * matching valuation CSV, which the replay test then asserts on.
 *
 * Deterministic: a fixed seed means the fixture is reproducible and diffs are
 * meaningful.
 *
 *   node tools/simulate.js > fixtures/sample-draft.json
 */

import { EventType, makeEvent } from '../src/core/events.js';
import { DEFAULT_CONFIG, expandSlots, slotAccepts } from '../src/core/config.js';
import { rescaleToLeague } from '../src/core/valuations.js';

/** mulberry32 — small, seeded, good enough for fixtures. */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Bijan', 'CeeDee', 'Justin', 'Amon-Ra', 'Marvin', 'Breece', 'Puka', 'Garrett',
  'Jahmyr', 'Nico', 'Malik', 'Brock', 'Kyren', 'Rome', 'Trey', 'Chris', 'Tank', 'Zay',
  'Drake', 'Jaxon', 'Tyrone', 'Deebo', 'Rashee', 'Jordan', 'Isiah', 'Quentin', 'Khalil',
  'Blake', 'Sam', 'Dalton', 'Cooper', 'Micah'];
const LAST = ['Robinson', 'Lamb', 'Jefferson', 'Brown', 'Harrison', 'Hall', 'Nacua', 'Wilson',
  'Gibbs', 'Collins', 'Nabers', 'Bowers', 'Williams', 'Odunze', 'McBride', 'Olave', 'Dell',
  'Flowers', 'London', 'Smith-Njigba', 'Tracy', 'Samuel', 'Rice', 'Addison', 'Pacheco',
  'Johnston', 'Shakir', 'Corum', 'LaPorta', 'Kincaid', 'Kupp', 'Parsons'];
const NFL = ['ATL', 'DAL', 'MIN', 'DET', 'ARI', 'NYJ', 'LAR', 'SEA', 'BUF', 'HOU', 'NYG',
  'LV', 'CHI', 'PHI', 'KC', 'NO', 'CIN', 'BAL', 'SF', 'TB'];

const config = {
  ...DEFAULT_CONFIG,
  numTeams: 12,
  budget: 200,
  minBid: 1,
  rosterSlots: expandSlots({ QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, K: 1, DST: 1, BN: 6 }),
};

const rosterSize = config.rosterSlots.length;
const totalSpots = config.numTeams * rosterSize;

// --- player pool -------------------------------------------------------------
// Positional supply roughly mirrors a real player pool, and values follow a
// steep power curve so tier cliffs are real rather than uniform.
const POOL = { QB: 24, RB: 60, WR: 72, TE: 24, K: 14, DST: 14 };
const POS_TOP = { QB: 30, RB: 62, WR: 60, TE: 34, K: 2, DST: 3 };

function buildPlayers(rand) {
  const players = [];
  for (const [pos, count] of Object.entries(POOL)) {
    for (let i = 0; i < count; i += 1) {
      const decay = Math.exp(-i / (count * 0.28));
      const noise = 0.9 + rand() * 0.2;
      const value = Math.max(1, Math.round(POS_TOP[pos] * decay * noise));
      players.push({
        name: `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]} ${pos}${i + 1}`,
        position: pos,
        nflTeam: NFL[Math.floor(rand() * NFL.length)],
        value,
      });
    }
  }
  return players;
}

// --- draft -------------------------------------------------------------------
function simulate(seed = 20260817) {
  const rand = rng(seed);
  // Scale the pool so total par equals total league money. Without this the
  // simulated teams pay par for early studs and run dry halfway through,
  // producing a fixture that exercises only the broke end of the market.
  const players = rescaleToLeague(buildPlayers(rand), config)
    .filter((p) => p.value > 0 || !p.rosterable);
  const log = [];
  let eventId = 0;
  const next = (type, payload, meta = {}) =>
    log.push(makeEvent(type, payload, { id: `e${++eventId}`, source: 'ws', ts: 1_700_000_000_000 + eventId * 1000, ...meta }));

  next(EventType.LEAGUE_CONFIGURED, config, { source: 'manual' });

  const teams = Array.from({ length: config.numTeams }, (_, i) => ({
    teamId: `team-${i + 1}`,
    teamName: `Team ${i + 1}`,
    spent: 0,
    slots: config.rosterSlots.map((type) => ({ type, filled: false })),
  }));
  for (const t of teams) next(EventType.TEAM_REGISTERED, { teamId: t.teamId, teamName: t.teamName });

  const openSlots = (t) => t.slots.filter((s) => !s.filled).length;
  const maxBid = (t) => {
    const open = openSlots(t);
    return open === 0 ? 0 : (config.budget - t.spent) - (open - 1) * config.minBid;
  };
  const canTake = (t, pos) => t.slots.some((s) => !s.filled && slotAccepts(s.type, pos));

  const available = [...players].sort((a, b) => b.value - a.value);
  let sold = 0;

  while (sold < totalSpots && available.length) {
    // Nomination: mostly the best player left, sometimes a random one -- real
    // rooms mix value nominations with price enforcement.
    const idx = rand() < 0.7 ? 0 : Math.floor(rand() * Math.min(20, available.length));
    const player = available.splice(idx, 1)[0];

    const bidders = teams.filter((t) => canTake(t, player.position) && maxBid(t) >= config.minBid);
    if (!bidders.length) continue;

    next(EventType.NOMINATION, {
      playerName: player.name,
      position: player.position,
      nflTeam: player.nflTeam,
      openingBid: config.minBid,
      nominatingTeamId: bidders[Math.floor(rand() * bidders.length)].teamId,
    });

    // Price forms around par with noise, then gets clipped by what the field
    // can actually afford -- this is what produces realistic late-draft
    // bargains and the inflation swings the analytics are meant to catch.
    const ceiling = Math.max(...bidders.map(maxBid));
    const wanted = Math.max(config.minBid, Math.round(player.value * (0.75 + rand() * 0.55)));
    const price = Math.max(config.minBid, Math.min(wanted, ceiling));

    const affordable = bidders.filter((t) => maxBid(t) >= price);
    const winner = affordable[Math.floor(rand() * affordable.length)] ?? bidders[0];

    // A couple of intermediate bids so the BID path gets exercised too.
    for (let step = Math.max(1, Math.floor(price / 2)); step < price; step += Math.max(1, Math.floor(price / 3))) {
      const other = bidders[Math.floor(rand() * bidders.length)];
      next(EventType.BID, { amount: step, teamId: other.teamId });
    }

    next(EventType.SOLD, {
      playerName: player.name,
      position: player.position,
      nflTeam: player.nflTeam,
      teamId: winner.teamId,
      teamName: winner.teamName,
      price,
    });

    const slot = winner.slots.find((s) => !s.filled && slotAccepts(s.type, player.position));
    slot.filled = true;
    winner.spent += price;
    sold += 1;
  }

  next(EventType.DRAFT_COMPLETE, {});
  return { config, log, players };
}

function toCsv(players) {
  const rows = [['Rank', 'Player', 'Team', 'Position', 'Auction Value']];
  [...players]
    .sort((a, b) => b.value - a.value)
    .forEach((p, i) => rows.push([i + 1, p.name, p.nflTeam, p.position, `$${p.value}`]));
  return rows.map((r) => r.map((c) => (String(c).includes(',') ? `"${c}"` : c)).join(',')).join('\n');
}

export { simulate, toCsv, config as simConfig };

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config: cfg, log, players } = simulate();
  const which = process.argv[2] ?? 'draft';
  if (which === 'csv') {
    process.stdout.write(toCsv(players));
  } else {
    process.stdout.write(JSON.stringify({ version: 1, config: cfg, log }, null, 2));
  }
}
