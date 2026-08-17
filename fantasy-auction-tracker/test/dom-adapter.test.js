/**
 * DOM adapter tests, driven through a real DOM (linkedom).
 *
 * Scope note: these prove the adapter turns a page of the expected SHAPE into
 * correct draft events, including the messy cases real rooms produce. They do
 * not prove the CBS selectors match the live site -- nothing runnable offline
 * can prove that. tools/selftest.js is what closes that gap, in the room.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHTML } from 'linkedom';

import { profileFor } from '../src/adapters/profiles.js';
import { GenericDomAdapter } from '../src/adapters/generic-dom.js';
import { parseMoney } from '../src/adapters/base.js';
import { DraftStore } from '../src/core/store.js';
import { EventType } from '../src/core/events.js';
import { DEFAULT_CONFIG, expandSlots } from '../src/core/config.js';
import { playerKey } from '../src/core/players.js';

const here = dirname(fileURLToPath(import.meta.url));
const roomHtml = readFileSync(join(here, '..', 'fixtures', 'cbs-draft-room.html'), 'utf8');

const cbs = profileFor('https://www.cbssports.com/fantasy/football/draft/');

const config = {
  ...DEFAULT_CONFIG,
  numTeams: 3,
  budget: 200,
  rosterSlots: expandSlots({ QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1, BN: 4 }),
};

let saved;

/** Install a DOM into globals, since the adapter reads `document` directly. */
function mountDom(html) {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  saved = {
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    window: globalThis.window,
  };
  globalThis.document = document;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.window = window;
  return { window, document };
}

beforeEach(() => { mountDom(roomHtml); });

afterEach(() => {
  if (!saved) return;
  globalThis.document = saved.document;
  globalThis.MutationObserver = saved.MutationObserver;
  globalThis.window = saved.window;
});

/** Run one synchronous scan and collect what the adapter emitted. */
function scanOnce(profile = cbs) {
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile });
  adapter.scan();
  return { events, adapter };
}

const ofType = (events, type) => events.filter((e) => e.type === type);

// --- profile resolution -----------------------------------------------------

test('the CBS profile is selected for a cbssports.com URL', () => {
  assert.equal(cbs.id, 'cbs');
  assert.equal(profileFor('https://www.espn.com/whatever'), null);
});

test('user overrides merge over the shipped selectors', () => {
  const custom = profileFor('https://www.cbssports.com/x', {
    selectors: { nomName: '.my-own-name' },
  });
  assert.equal(custom.selectors.nomName, '.my-own-name');
  assert.equal(custom.selectors.rowPrice, cbs.selectors.rowPrice, 'untouched keys survive');
});

// --- nomination -------------------------------------------------------------

test('the live nomination is read, with position and NFL team', () => {
  const { events } = scanOnce();
  const [nom] = ofType(events, EventType.NOMINATION);

  assert.ok(nom, 'a nomination was emitted');
  assert.equal(nom.payload.playerName, "Ja'Marr Chase");
  assert.equal(nom.payload.position, 'WR');
  assert.equal(nom.payload.nflTeam, 'CIN');
  assert.equal(nom.payload.openingBid, 47);
  assert.equal(nom.source, 'dom');
});

test('the current bid and high bidder are emitted as a BID', () => {
  const { events } = scanOnce();
  const [bid] = ofType(events, EventType.BID);

  assert.equal(bid.payload.amount, 47);
  assert.equal(bid.payload.teamId, 'Gridiron Gurus');
});

test('a repeat scan does not re-emit an unchanged nomination', () => {
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile: cbs });
  adapter.scan();
  adapter.scan();
  adapter.scan();

  assert.equal(ofType(events, EventType.NOMINATION).length, 1, 'nominated once, not three times');
  assert.equal(ofType(events, EventType.BID).length, 1);
});

test('a new player on the block produces a fresh nomination', () => {
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile: cbs });
  adapter.scan();

  document.querySelector('.auction-nomination .player-name').textContent = 'Justin Jefferson';
  document.querySelector('.current-bid').textContent = '$12';
  adapter.scan();

  const noms = ofType(events, EventType.NOMINATION);
  assert.equal(noms.length, 2);
  assert.equal(noms[1].payload.playerName, 'Justin Jefferson');
  assert.equal(noms[1].payload.openingBid, 12);
});

test('a rising bid on the same player emits BIDs, not nominations', () => {
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile: cbs });
  adapter.scan();

  for (const [amount, team] of [[50, 'Team Chaos'], [55, 'Gridiron Gurus']]) {
    document.querySelector('.current-bid').textContent = `$${amount}`;
    document.querySelector('.high-bidder').textContent = team;
    adapter.scan();
  }

  assert.equal(ofType(events, EventType.NOMINATION).length, 1);
  const bids = ofType(events, EventType.BID);
  assert.deepEqual(bids.map((b) => b.payload.amount), [47, 50, 55]);
  assert.equal(bids.at(-1).payload.teamId, 'Gridiron Gurus');
});

test('an empty nomination area emits nothing rather than throwing', () => {
  document.querySelector('.auction-nomination').remove();
  const { events } = scanOnce();
  assert.equal(ofType(events, EventType.NOMINATION).length, 0);
});

// --- results ----------------------------------------------------------------

test('completed sales are read from the results table', () => {
  const { events } = scanOnce();
  const sales = ofType(events, EventType.SOLD);

  assert.equal(sales.length, 4);
  const byName = Object.fromEntries(sales.map((s) => [s.payload.playerName, s.payload]));

  assert.equal(byName['Bijan Robinson'].price, 58);
  assert.equal(byName['Bijan Robinson'].teamId, 'Team Chaos');
  assert.equal(byName['Bijan Robinson'].position, 'RB');
});

test('prices parse whether or not they carry a $ or stray whitespace', () => {
  const { events } = scanOnce();
  const byName = Object.fromEntries(
    ofType(events, EventType.SOLD).map((s) => [s.payload.playerName, s.payload.price]),
  );

  assert.equal(byName['Bijan Robinson'], 58, '"$58"');
  assert.equal(byName['Marvin Harrison Jr.'], 44, 'bare "44"');
  assert.equal(byName['San Francisco 49ers'], 7, '" $7 " with padding');
});

test('a header row parses to nothing and is skipped silently', () => {
  const { events } = scanOnce();
  assert.ok(!ofType(events, EventType.SOLD).some((s) => /Player|Pos|Price/.test(s.payload.playerName)));
});

test('a sale with no position is still recorded but flagged for review', () => {
  const { events } = scanOnce();
  const kraft = ofType(events, EventType.SOLD).find((s) => s.payload.playerName === 'Tucker Kraft');

  assert.ok(kraft, 'the sale is not dropped -- a missing position is not a missing sale');
  assert.equal(kraft.payload.position, 'UNK');
  assert.ok(kraft.confidence < 0.8, `confidence ${kraft.confidence} falls below the review threshold`);
});

test('a fully-parsed sale carries DOM-tier confidence', () => {
  const { events } = scanOnce();
  const bijan = ofType(events, EventType.SOLD).find((s) => s.payload.playerName === 'Bijan Robinson');
  assert.equal(bijan.confidence, 0.85);
});

test('already-seen sales are not re-emitted when the table re-renders', () => {
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile: cbs });
  adapter.scan();
  const first = ofType(events, EventType.SOLD).length;
  adapter.scan();

  assert.equal(ofType(events, EventType.SOLD).length, first, 'no duplicates on re-scan');
});

test('a newly appended sale is picked up', () => {
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile: cbs });
  adapter.scan();

  const tbody = document.querySelector('.draft-results tbody');
  const row = document.createElement('tr');
  row.className = 'results-row';
  row.innerHTML = '<td><span class="player-name">Puka Nacua</span></td>'
    + '<td><span class="player-position">WR</span></td>'
    + '<td><span class="bid-amount">$41</span></td>'
    + '<td><span class="team-name">Gridiron Gurus</span></td>';
  tbody.append(row);
  adapter.scan();

  const puka = ofType(events, EventType.SOLD).find((s) => s.payload.playerName === 'Puka Nacua');
  assert.ok(puka);
  assert.equal(puka.payload.price, 41);
});

// --- teams ------------------------------------------------------------------

test('teams are registered from the budget panel', () => {
  const { events } = scanOnce();
  const names = ofType(events, EventType.TEAM_REGISTERED).map((e) => e.payload.teamName);
  assert.deepEqual(names, ['Team Chaos', 'Gridiron Gurus', 'Waiver Wire Warriors']);
});

// --- resilience -------------------------------------------------------------

test('a selector that matches nothing degrades instead of throwing', () => {
  const broken = profileFor('https://www.cbssports.com/x', {
    selectors: { nomination: '.does-not-exist', resultRow: '.also-missing', teamRow: '.nope' },
  });
  const { events } = scanOnce(broken);
  assert.equal(events.length, 0, 'silence, not a crash');
});

test('scan survives a selector that throws', () => {
  const bad = profileFor('https://www.cbssports.com/x', {
    selectors: { resultRow: ':::not-valid-css:::' },
  });
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile: bad });
  assert.doesNotThrow(() => adapter.scan(), 'a bad selector must not kill the observer');
});

test('parseMoney extracts the number from whatever wrapping text', () => {
  assert.equal(parseMoney('$47'), 47);
  assert.equal(parseMoney('Sold for 58'), 58);
  assert.equal(parseMoney('$1,200'), 1200);
  assert.equal(parseMoney('—'), null);
  assert.equal(parseMoney(null), null);
});

// --- end to end -------------------------------------------------------------

test('a scan drives the store to correct league state', () => {
  const store = new DraftStore({ config });
  const adapter = new GenericDomAdapter((e) => store.append(e), { profile: cbs });
  adapter.scan();

  const state = store.state;

  // Three of the four sales are confident enough to apply; the position-less
  // one waits for confirmation rather than silently landing on a roster.
  assert.equal(state.history.length, 3);
  assert.equal(state.needsReview.length, 1);
  assert.equal(state.needsReview[0].payload.playerName, 'Tucker Kraft');

  const chaos = state.teams.get('Team Chaos');
  assert.equal(chaos.spent, 65, '$58 + $7');
  assert.equal(chaos.roster.length, 2);

  assert.ok(state.drafted.has(playerKey('Bijan Robinson', 'RB')));
  // The D/ST alias normalizes, so the defense is matchable against a CSV.
  assert.ok(state.drafted.has(playerKey('San Francisco 49ers', 'DST')));
  // The suffix normalizes, so "Marvin Harrison" in a CSV still resolves.
  assert.ok(state.drafted.has(playerKey('Marvin Harrison', 'WR')));
});

test('confirming the flagged sale applies it', () => {
  const store = new DraftStore({ config });
  const adapter = new GenericDomAdapter((e) => store.append(e), { profile: cbs });
  adapter.scan();

  const pending = store.state.needsReview[0];
  store.correct(pending.id, { position: 'TE' });

  assert.equal(store.state.history.length, 4);
  assert.equal(store.state.needsReview.length, 0);
  assert.ok(store.state.drafted.has(playerKey('Tucker Kraft', 'TE')));
});

test('the observer wires up and fires on a real mutation', async () => {
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile: cbs, debounceMs: 5 });
  await adapter.start();
  const initial = events.length;

  document.querySelector('.auction-nomination .player-name').textContent = 'Breece Hall';
  document.querySelector('.auction-nomination .player-position').textContent = 'RB';

  await new Promise((resolve) => setTimeout(resolve, 60));
  adapter.stop();

  assert.ok(events.length > initial, 'the mutation produced new events');
  assert.ok(
    ofType(events, EventType.NOMINATION).some((n) => n.payload.playerName === 'Breece Hall'),
    'the new nomination came through the observer, not a manual scan',
  );
});

test('stop() detaches the observer', async () => {
  const events = [];
  const adapter = new GenericDomAdapter((e) => events.push(e), { profile: cbs, debounceMs: 5 });
  await adapter.start();
  adapter.stop();
  const after = events.length;

  document.querySelector('.auction-nomination .player-name').textContent = 'Nobody Home';
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(events.length, after, 'no events after teardown');
});
