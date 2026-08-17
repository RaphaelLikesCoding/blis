/**
 * Valuation import.
 *
 * You bring your own numbers (FantasyPros export, a projection model, a
 * hand-tuned sheet). We only need name, position and a par auction value; rank
 * and tier are used for the tier-cliff read when present.
 *
 * Header matching is alias-based and case-insensitive so an export can be
 * dropped in without reshaping it first.
 */

import { normalizePosition, buildIndex } from './players.js';

const ALIASES = {
  name: ['player', 'player name', 'name', 'playername'],
  position: ['position', 'pos', 'player position'],
  nflTeam: ['team', 'nfl team', 'tm', 'team abbr'],
  value: ['auction value', 'value', '$', 'price', 'aav', 'auction $', 'cost', 'salary'],
  rank: ['rank', 'overall rank', 'ovr', 'rk', 'ecr'],
  tier: ['tier'],
  projection: ['points', 'proj', 'projected points', 'fpts', 'projection'],
  bye: ['bye', 'bye week'],
};

/** RFC4180-ish parser: handles quoted fields, embedded commas and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function mapHeaders(header) {
  const lower = header.map((h) => h.trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const idx = lower.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

function toMoney(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a valuation CSV into players plus a lookup index.
 *
 * FantasyPros writes position as "RB1"/"WR12" (position + positional rank);
 * we split that so the rank is not lost.
 *
 * @returns {{ players: Array, index: object, problems: string[] }}
 */
export function loadValuations(text, { source = 'csv' } = {}) {
  const rows = parseCsv(text);
  const problems = [];
  if (rows.length < 2) {
    return { players: [], index: buildIndex([]), problems: ['CSV has no data rows'] };
  }

  const cols = mapHeaders(rows[0]);
  if (cols.name == null) problems.push('no player-name column found');
  if (cols.value == null) {
    problems.push('no auction-value column found; valuation analytics will be disabled');
  }

  const players = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const rawName = (row[cols.name] ?? '').trim();
    if (!rawName) continue;

    let rawPos = (row[cols.position] ?? '').trim();
    let posRank = null;
    const m = /^([A-Za-z/]+)\s*(\d+)$/.exec(rawPos);
    if (m) { rawPos = m[1]; posRank = Number(m[2]); }

    const value = toMoney(row[cols.value]);
    players.push({
      name: rawName,
      position: normalizePosition(rawPos),
      nflTeam: (row[cols.nflTeam] ?? '').trim() || null,
      value: value ?? 0,
      hasValue: value != null,
      rank: toMoney(row[cols.rank]),
      posRank,
      tier: toMoney(row[cols.tier]),
      projection: toMoney(row[cols.projection]),
      bye: toMoney(row[cols.bye]),
      source,
    });
  }

  const missingPos = players.filter((p) => !p.position).length;
  if (missingPos) problems.push(`${missingPos} row(s) have no recognizable position`);
  const missingValue = players.filter((p) => !p.hasValue).length;
  if (missingValue) problems.push(`${missingValue} row(s) have no auction value (treated as $0)`);

  return { players, index: buildIndex(players), problems };
}

/**
 * Rescale values so they sum to the league's total money.
 *
 * A CSV built for a $200/12-team league is wrong in a $300/10-team league, and
 * silently comparing against mis-scaled par values would bias every suggestion.
 * Only the top `spots` players (the rosterable pool) are scaled; the $1 floor
 * is honoured for each of them.
 */
export function rescaleToLeague(players, config) {
  const spots = config.numTeams * config.rosterSlots.filter((s) => s !== 'IR').length;
  const pool = [...players]
    .sort((a, b) => b.value - a.value)
    .slice(0, spots);

  const totalMoney = config.numTeams * config.budget;
  const floor = config.minBid * pool.length;
  const discretionary = totalMoney - floor;
  const poolSurplus = pool.reduce((s, p) => s + Math.max(0, p.value - config.minBid), 0);

  if (poolSurplus <= 0 || discretionary <= 0) return players;
  const factor = discretionary / poolSurplus;

  const scaled = new Map();
  for (const p of pool) {
    scaled.set(p, config.minBid + Math.max(0, p.value - config.minBid) * factor);
  }
  return players.map((p) => ({
    ...p,
    rawValue: p.value,
    value: scaled.has(p) ? Math.round(scaled.get(p) * 10) / 10 : 0,
    rosterable: scaled.has(p),
  }));
}
