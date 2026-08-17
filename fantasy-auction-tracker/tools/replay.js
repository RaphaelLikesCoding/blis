#!/usr/bin/env node
/**
 * Replay a recorded draft log through the real store and analytics.
 *
 * This is the rehearsal you cannot otherwise have. Point it at a log exported
 * from the sidebar (or the synthetic fixture) and watch the same numbers the
 * sidebar would have shown, sale by sale.
 *
 *   node tools/replay.js fixtures/sample-draft.json fixtures/sample-values.csv
 *   node tools/replay.js fixtures/sample-draft.json fixtures/sample-values.csv --at 100
 */

import { readFileSync } from 'node:fs';

import { DraftStore } from '../src/core/store.js';
import { EventType } from '../src/core/events.js';
import { loadValuations, rescaleToLeague } from '../src/core/valuations.js';
import { inflation, scarcity, budgetPressure, bidAdvice } from '../src/core/analytics.js';
import { buildTargets, tierPressure, planFeasibility, targetStatus } from '../src/core/targets.js';
import { allTeamSummaries } from '../src/core/reducer.js';

const money = (n) => `$${Math.round(n)}`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padNum = (s, n) => String(s).padStart(n);

export function replay(logData, valuations, { until = Infinity } = {}) {
  const store = new DraftStore({ config: logData.config, log: [] });
  const timeline = [];

  for (const event of logData.log) {
    if (store.log.length >= until) break;
    // Bypass the dedup guard: a recorded log is already deduplicated, and
    // re-checking it would drop legitimate repeat prices.
    store.log.push(event);

    if (event.type === EventType.SOLD) {
      store.recompute();
      timeline.push({
        index: timeline.length + 1,
        sale: store.state.history.at(-1),
        inflation: inflation(store.state, valuations).discretionary,
      });
    }
  }
  store.recompute();
  return { store, timeline };
}

function main() {
  const [logPath, csvPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const atFlag = process.argv.indexOf('--at');
  const until = atFlag !== -1 ? Number(process.argv[atFlag + 1]) : Infinity;
  const targetsFlag = process.argv.indexOf('--targets');
  const targetsPath = targetsFlag !== -1 ? process.argv[targetsFlag + 1] : null;
  const meFlag = process.argv.indexOf('--me');
  const myTeamId = meFlag !== -1 ? process.argv[meFlag + 1] : null;

  if (!logPath) {
    console.error('usage: node tools/replay.js <draft-log.json> [values.csv] '
      + '[--at N] [--targets targets.json] [--me <team-id>]');
    process.exit(1);
  }

  const logData = JSON.parse(readFileSync(logPath, 'utf8'));
  if (myTeamId) logData.config = { ...logData.config, myTeamId };
  let valuations = [];
  if (csvPath) {
    const { players, problems } = loadValuations(readFileSync(csvPath, 'utf8'));
    valuations = rescaleToLeague(players, logData.config);
    if (problems.length) console.error(`csv notes: ${problems.join('; ')}`);
  }

  const targets = targetsPath
    ? buildTargets(JSON.parse(readFileSync(targetsPath, 'utf8')))
    : [];

  const { store, timeline } = replay(logData, valuations, { until });
  const state = store.state;

  console.log(`\nreplayed ${store.log.length} events -> ${state.history.length} sales\n`);

  console.log('last 10 sales');
  console.log('  ' + pad('player', 26) + pad('pos', 5) + pad('team', 10) + padNum('price', 6) + padNum('par', 6) + padNum('infl', 7));
  for (const row of timeline.slice(-10)) {
    const val = valuations.find((p) => `${p.name}|${p.position}` === `${row.sale.name}|${row.sale.position}`);
    console.log('  '
      + pad(row.sale.name, 26)
      + pad(row.sale.position, 5)
      + pad(row.sale.teamId, 10)
      + padNum(money(row.sale.price), 6)
      + padNum(val ? money(val.value) : '—', 6)
      + padNum(row.inflation.toFixed(2), 7));
  }

  console.log('\nteams');
  console.log('  ' + pad('team', 12) + padNum('spent', 7) + padNum('left', 6) + padNum('slots', 6) + padNum('max', 6) + '  needs');
  for (const t of allTeamSummaries(state).sort((a, b) => b.maxBid - a.maxBid)) {
    const needs = Object.entries(t.needs).filter(([s]) => s !== 'BN').map(([s, n]) => (n > 1 ? `${s}x${n}` : s)).join(' ');
    console.log('  '
      + pad(t.teamName, 12)
      + padNum(money(t.spent), 7)
      + padNum(money(t.remaining), 6)
      + padNum(t.openSlots, 6)
      + padNum(money(t.maxBid), 6)
      + '  ' + needs);
  }

  if (valuations.length) {
    const inf = inflation(state, valuations);
    console.log(`\ninflation ${inf.discretionary.toFixed(2)} `
      + `(${money(inf.remainingMoney)} chasing ${money(inf.remainingValue)} over ${inf.openSpots} spots, `
      + `${money(inf.surplusSpent)} spent above par)`);

    console.log('\nscarcity');
    for (const [pos, s] of Object.entries(scarcity(state, valuations))) {
      if (!s.available && !s.openStarterSlots) continue;
      console.log(`  ${pad(pos, 5)}${padNum(s.startable, 4)} startable / ${padNum(s.openStarterSlots, 3)} slots`
        + `  ratio ${Number.isFinite(s.ratio) ? s.ratio.toFixed(2) : 'inf'}`
        + `  best: ${s.topAvailable[0]?.name ?? '—'}`);
    }

    const advice = bidAdvice(state, valuations);
    if (advice) {
      console.log(`\non the block: ${advice.player} (${advice.position}) at ${money(advice.currentBid)}`
        + ` -> ${advice.verdict.toUpperCase()}  walk-away ${money(advice.walkAway)}, ceiling ${money(advice.ceiling)}`);
    }
  }

  if (targets.length) {
    const inf = inflation(state, valuations).discretionary;
    const plan = planFeasibility(state, targets, { valuations, inflation: inf });

    console.log('\ntarget board');
    for (const row of tierPressure(state, targets)) {
      const flag = row.exhausted ? ' EXHAUSTED' : row.critical ? ' CRITICAL' : '';
      console.log(`  tier ${row.tier}: ${padNum(row.open, 2)}/${row.total} open`
        + `  won ${row.won} (${money(row.spent)})  lost ${row.lost}${flag}`);
    }

    const missed = targetStatus(state, targets)
      .filter((t) => t.status === 'lost' && t.overshoot != null)
      .sort((a, b) => b.overshoot - a.overshoot)
      .slice(0, 5);
    if (missed.length) {
      console.log('  biggest misses: '
        + missed.map((t) => `${t.name} (+${t.overshoot} over your ${money(t.maxPrice)})`).join(', '));
    }

    console.log(`\nplan: ${money(plan.plannedCost)} of targets for ${plan.plan.length} of `
      + `${plan.openSlots} open slots, ${money(plan.budget)} available -- `
      + (plan.feasible ? `${money(plan.headroom)} headroom` : `SHORT BY ${money(plan.shortfall)}`));
    if (plan.unslotted.length) {
      console.log(`  no slot for: ${plan.unslotted.map((t) => t.name).join(', ')}`);
    }
  }

  const pressure = budgetPressure(state).filter((t) => t.openSlots > 0).slice(0, 3);
  if (pressure.length) {
    console.log('\nmost budget-constrained: '
      + pressure.map((t) => `${t.teamName} (${Math.round(t.locked * 100)}%)`).join(', '));
  }

  if (state.warnings.length) {
    console.log(`\n${state.warnings.length} warning(s):`);
    for (const w of state.warnings.slice(0, 5)) console.log(`  - ${w.message}`);
  }
  console.log();
}

if (import.meta.url === `file://${process.argv[1]}`) main();
