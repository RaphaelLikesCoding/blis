/**
 * Tests for the in-room self-test tool.
 *
 * This tool is what the user leans on to decide whether the tracker will work
 * in their draft room, so a false "everything is fine" is worse than no tool at
 * all. These check it reports OK on a matching page, FAIL on a broken one, and
 * distinguishes "selector is wrong" from "nothing has happened yet".
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHTML } from 'linkedom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const roomHtml = readFileSync(join(root, 'fixtures', 'cbs-draft-room.html'), 'utf8');
const selfTestSource = readFileSync(join(root, 'tools', 'selftest.js'), 'utf8');

let saved;
let logs;

function mount(html, href = 'https://www.cbssports.com/fantasy/football/draft/') {
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  saved = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    console: globalThis.console,
    MutationObserver: globalThis.MutationObserver,
  };

  logs = [];
  const record = (...args) => logs.push(args.map(String).join(' '));

  globalThis.document = document;
  globalThis.window = window;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.location = new URL(href);
  globalThis.console = {
    log: record, warn: record, group: record, groupEnd: () => {},
    table: (rows) => logs.push(JSON.stringify(rows)),
  };

  // Evaluate the tool exactly as a console paste would.
  // eslint-disable-next-line no-new-func
  new Function(selfTestSource)();
  return { window, document };
}

beforeEach(() => { mount(roomHtml); });

afterEach(() => {
  if (!saved) return;
  Object.assign(globalThis, saved);
});

const statusOf = (result, field) => result.rows.find((r) => r.field === field)?.status;

test('the profile is detected from the CBS hostname', () => {
  const result = globalThis.window.__auctionSelfTest();
  assert.ok(result, 'a CBS URL resolves a profile without being told which');
  assert.ok(logs.some((l) => /CBS Sports Fantasy/.test(l)));
});

test('an unknown host refuses rather than guessing', () => {
  mount(roomHtml, 'https://example.com/');
  assert.equal(globalThis.window.__auctionSelfTest(), null);
  assert.ok(logs.some((l) => /No profile for/.test(l)));
});

test('every selector resolves against a matching room', () => {
  const result = globalThis.window.__auctionSelfTest();

  for (const field of ['nomination', 'nomName', 'nomPosition', 'highBid', 'highBidder',
    'resultRow', 'rowPlayer', 'rowPrice', 'rowTeam', 'teamRow', 'teamName', 'teamBudget']) {
    assert.equal(statusOf(result, field), 'OK', `${field} should resolve`);
  }
  assert.deepEqual(Object.keys(result.broken), []);
  assert.ok(logs.some((l) => /every selector resolved/.test(l)));
});

test('it reports the sales it would emit, with prices parsed', () => {
  const result = globalThis.window.__auctionSelfTest();

  assert.equal(result.sales.length, 4);
  const bijan = result.sales.find((s) => s.player === 'Bijan Robinson');
  assert.equal(bijan.price, 58);
  assert.equal(bijan.team, 'Team Chaos');
});

test('it warns about sales parsed without a position', () => {
  globalThis.window.__auctionSelfTest();
  assert.ok(
    logs.some((l) => /parsed without a position/.test(l)),
    'a position-less sale is called out, since those never auto-apply',
  );
});

test('it lists the teams it would register', () => {
  const result = globalThis.window.__auctionSelfTest();
  assert.deepEqual(
    result.teams.map((t) => t.team),
    ['Team Chaos', 'Gridiron Gurus', 'Waiver Wire Warriors'],
  );
  assert.equal(result.teams[0].budget, '$135');
});

test('a wrong selector is reported as broken, not quietly ignored', () => {
  const result = globalThis.window.__auctionSelfTest('cbs', { rowPrice: '.totally-wrong' });

  // FAIL, not EMPTY: the results rows exist, so "wait for a sale" is no
  // excuse -- the selector is genuinely wrong and must be called out as such.
  assert.equal(statusOf(result, 'rowPrice'), 'FAIL');
  assert.ok('rowPrice' in result.broken);
  assert.ok(logs.some((l) => /selector\(s\) need fixing/.test(l)));
  assert.ok(
    logs.some((l) => /without them no sale is ever recorded/.test(l)),
    'a broken price selector is flagged as critical, not cosmetic',
  );
});

test('invalid CSS is reported distinctly from a selector that simply misses', () => {
  const result = globalThis.window.__auctionSelfTest('cbs', { teamRow: ':::nope:::' });
  assert.equal(statusOf(result, 'teamRow'), 'INVALID');
});

test('a missing nomination marks its children NO-SCOPE, not FAIL', () => {
  // Mid-draft lulls have no player on the block. Reporting nomName as broken
  // then would send the user chasing a selector that is actually correct.
  document.querySelector('.auction-nomination').remove();
  const result = globalThis.window.__auctionSelfTest();

  assert.equal(statusOf(result, 'nomination'), 'EMPTY');
  assert.equal(statusOf(result, 'nomName'), 'NO-SCOPE');
  assert.ok(!('nomName' in result.broken), 'not counted as broken');
});

test('an empty pre-draft room tells you what to do rather than failing', () => {
  mount('<div class="draft-room"></div>');
  const result = globalThis.window.__auctionSelfTest();

  assert.equal(statusOf(result, 'nomination'), 'EMPTY');
  assert.equal(statusOf(result, 'resultRow'), 'EMPTY');
  assert.ok(
    result.rows.find((r) => r.field === 'nomination').found.includes('nominate a player'),
    'says what action would populate it',
  );
  assert.ok(
    result.rows.find((r) => r.field === 'resultRow').found.includes('let a sale complete'),
  );
});

test('a completely foreign page reports the critical selectors broken', () => {
  mount('<div class="some-other-app"><span>nothing familiar</span></div>');
  const result = globalThis.window.__auctionSelfTest('cbs');

  assert.equal(result.sales.length, 0);
  assert.ok(logs.some((l) => /need fixing/.test(l)));
});

test('it prints a pasteable selector override block', () => {
  globalThis.window.__auctionSelfTest();
  const printed = logs.find((l) => l.trim().startsWith('{') && l.includes('"selectors"'));
  assert.ok(printed, 'a JSON fragment is emitted');
  assert.equal(JSON.parse(printed).selectors.rowPrice, '.bid-amount, .price, .salary');
});

test('the live watcher warns when nothing observable changes', async () => {
  globalThis.window.__auctionSelfTestLive(0.05);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(
    logs.some((l) => /fewer than 2 distinct states/.test(l)),
    'a static page is called out as untrackable rather than passing silently',
  );
});

test('the live watcher confirms when bids do move', async () => {
  globalThis.window.__auctionSelfTestLive(0.4);
  for (const amount of [50, 55, 61]) {
    document.querySelector('.current-bid').textContent = `$${amount}`;
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 450));

  assert.ok(
    logs.some((l) => /distinct bid states/.test(l)),
    'observable bid movement is reported as a pass',
  );
});

test('the self-test selectors match the shipped CBS profile', async () => {
  // The tool is standalone (pasteable with no extension loaded), so its copy
  // of the selectors can drift from the real profile. That drift would make it
  // certify selectors the adapter does not actually use.
  const { profileFor } = await import('../src/adapters/profiles.js');
  const shipped = profileFor('https://www.cbssports.com/x').selectors;
  const result = globalThis.window.__auctionSelfTest();
  const used = JSON.parse(logs.find((l) => l.trim().startsWith('{') && l.includes('"selectors"'))).selectors;

  assert.deepEqual(used, shipped, 'tools/selftest.js has drifted from profiles.js');
});
