/**
 * Sidebar UI.
 *
 * Pure view layer: it renders snapshots pushed by the background page and
 * sends user intent back. No analytics live here, so the numbers on screen are
 * always the same numbers the tests cover.
 */

import { EventType } from '../core/events.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};
const money = (n) => (n == null || Number.isNaN(n) ? '—' : `$${Math.round(n)}`);

let latest = null;

// --- tabs -------------------------------------------------------------------
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.panel')) {
      p.classList.toggle('active', p.id === `panel-${tab.dataset.panel}`);
    }
  });
}

// --- render -----------------------------------------------------------------
function renderStatus(snap) {
  const node = $('#status');
  const age = snap.status.lastEventAt ? Date.now() - snap.status.lastEventAt : null;
  if (!snap.logLength) {
    node.textContent = 'waiting for draft';
    node.className = 'status';
  } else if (snap.status.source === 'ws') {
    node.textContent = 'live (websocket)';
    node.className = 'status live';
  } else {
    node.textContent = `live (${snap.status.source ?? 'dom'})`;
    node.className = 'status degraded';
  }
  node.title = age != null ? `last event ${Math.round(age / 1000)}s ago` : 'no events yet';
}

function renderAdvice(snap) {
  const box = $('#advice');
  box.textContent = '';
  const a = snap.advice;

  if (!a) {
    box.append(el('p', { className: 'empty' }, 'Nothing on the block.'));
    return;
  }

  const explain = {
    bid: 'Below your inflation-adjusted value — this is profit.',
    stretch: 'Above par but inside your cliff allowance. Only if you want the player.',
    pass: 'At or past your ceiling. Let it go.',
    unvalued: 'No valuation for this player. Bid on your own read.',
    'no-slot': 'No open roster slot accepts this position.',
  }[a.verdict];

  box.append(
    el('div', {}, [
      el('span', { className: 'player' }, a.player),
      ' ',
      el('span', { className: 'pos' }, a.position),
      ' ',
      el('span', { className: `verdict ${a.verdict}` }, a.verdict),
    ]),
    el('div', { className: 'numbers' }, [
      el('div', {}, [el('span', { className: 'k' }, 'On board'), el('span', { className: 'v' }, money(a.currentBid))]),
      el('div', {}, [el('span', { className: 'k' }, 'Walk away'), el('span', { className: 'v' }, money(a.walkAway))]),
      el('div', {}, [el('span', { className: 'k' }, 'Ceiling'), el('span', { className: 'v' }, money(a.ceiling))]),
    ]),
    a.isTarget
      ? el('p', { className: 'hint target-line' },
        `On your board — tier ${a.targetTier}, your price ${money(a.targetPrice)}`
        + (a.targetVsMarket != null && a.targetVsMarket !== 0
          ? ` (${a.targetVsMarket > 0 ? '+' : ''}${a.targetVsMarket} vs market)` : '')
        + (a.targetNote ? ` — ${a.targetNote}` : ''))
      : el('p', { className: 'hint' }, 'Not on your target board.'),
    el('p', { className: 'hint' }, explain ?? ''),
    el('p', { className: 'hint' },
      `par ${money(a.parValue)} × inflation ${a.inflation} · cliff ${money(a.tierCliff)} to ${a.nextBest ?? 'nobody'} · `
      + `${a.threats} rival${a.threats === 1 ? '' : 's'} can outbid`
      + (a.topRival ? ` (max ${money(a.topRival.maxBid)}, ${a.topRival.teamName})` : '')
      + (a.myMaxBid != null ? ` · your max ${money(a.myMaxBid)}` : '')),
  );
}

function renderHistory(snap) {
  const body = $('#history tbody');
  body.textContent = '';
  for (const sale of snap.history) {
    const par = sale.parValue;
    const delta = par != null ? sale.price - par : null;
    body.append(el('tr', {}, [
      el('td', { title: sale.name }, sale.name),
      el('td', {}, sale.position ?? '—'),
      el('td', { title: sale.teamId }, sale.teamId),
      el('td', { className: 'num' }, money(sale.price)),
      el('td', { className: `num ${delta > 0 ? 'over' : 'under'}` },
        delta == null ? '—' : `${delta > 0 ? '+' : ''}${Math.round(delta)}`),
    ]));
  }
}

function renderTeams(snap) {
  const body = $('#teams tbody');
  body.textContent = '';
  const sorted = [...snap.teams].sort((a, b) => b.maxBid - a.maxBid);
  for (const t of sorted) {
    const needs = Object.entries(t.needs)
      .filter(([slot]) => slot !== 'BN')
      .map(([slot, n]) => (n > 1 ? `${slot}×${n}` : slot))
      .join(' ');
    body.append(el('tr', {
      className: [
        t.teamId === snap.config.myTeamId ? 'me' : '',
        t.maxBid <= 1 ? 'broke' : '',
      ].filter(Boolean).join(' '),
    }, [
      el('td', { title: t.teamName }, t.teamName),
      el('td', { className: 'num' }, money(t.remaining)),
      el('td', { className: 'num' }, String(t.openSlots)),
      el('td', { className: 'num' }, money(t.maxBid)),
      el('td', { title: needs }, needs || '—'),
    ]));
  }
}

function renderMarket(snap) {
  const inf = snap.inflation;
  const box = $('#inflation');
  box.textContent = '';
  const rate = inf.discretionary;
  const reading = rate > 1.05
    ? 'Money is chasing fewer players — expect to overpay from here.'
    : rate < 0.95
      ? 'Value is outrunning money — bargains ahead, stay patient.'
      : 'Market is near par.';
  box.append(
    el('div', { className: 'numbers' }, [
      el('div', {}, [el('span', { className: 'k' }, 'Inflation'), el('span', { className: 'v' }, rate.toFixed(2))]),
      el('div', {}, [el('span', { className: 'k' }, '$ left'), el('span', { className: 'v' }, money(inf.remainingMoney))]),
      el('div', {}, [el('span', { className: 'k' }, 'Spots left'), el('span', { className: 'v' }, String(inf.openSpots))]),
    ]),
    el('p', { className: 'hint' }, reading),
    el('p', { className: 'hint' },
      `${money(Math.abs(inf.surplusSpent))} ${inf.surplusSpent >= 0 ? 'over' : 'under'} par spent so far.`),
  );

  const scarcityBody = $('#scarcity tbody');
  scarcityBody.textContent = '';
  for (const [pos, s] of Object.entries(snap.scarcity)) {
    if (!s.available && !s.openStarterSlots) continue;
    scarcityBody.append(el('tr', {}, [
      el('td', {}, pos),
      el('td', { className: 'num' }, String(s.startable)),
      el('td', { className: 'num' }, String(s.openStarterSlots)),
      el('td', { className: `num ${s.ratio < 1 ? 'over' : ''}` },
        Number.isFinite(s.ratio) ? s.ratio.toFixed(2) : '∞'),
      el('td', { title: s.topAvailable.map((p) => p.name).join(', ') },
        s.topAvailable[0]?.name ?? '—'),
    ]));
  }

  const pressureBody = $('#pressure tbody');
  pressureBody.textContent = '';
  for (const t of snap.pressure) {
    pressureBody.append(el('tr', {}, [
      el('td', {}, t.teamName),
      el('td', { className: 'num' }, money(t.remaining)),
      el('td', { className: 'num' }, String(t.openSlots)),
      el('td', { className: `num ${t.locked > 0.8 ? 'over' : ''}` }, `${Math.round(t.locked * 100)}%`),
    ]));
  }
}

function renderAlerts(snap) {
  const box = $('#alerts');
  box.textContent = '';

  for (const item of snap.needsReview.slice(-5)) {
    const p = item.payload;
    box.append(el('div', { className: 'alert review' }, [
      `Unsure: ${p.playerName ?? item.type} `
      + (p.price != null ? `for ${money(p.price)} to ${p.teamId} ` : ''),
      el('button', {
        onclick: () => send({ kind: 'correct', targetId: item.id, patch: {} }),
      }, 'Confirm'),
      el('button', {
        onclick: () => send({ kind: 'retract', targetId: item.id, reason: 'rejected in review' }),
      }, 'Discard'),
    ]));
  }

  for (const w of snap.warnings.slice(-5)) {
    box.append(el('div', { className: 'alert' }, w.message));
  }

  if (!snap.valuationCount) {
    box.append(el('div', { className: 'alert' },
      'No valuations loaded — inflation and bid advice are off. Import a CSV in Setup.'));
  }
}


// --- targets ----------------------------------------------------------------
/** Local working copy, so an in-progress edit is not clobbered by a snapshot. */
let editing = null;

function saveTargets(rows) {
  send({ kind: 'set-targets', targets: rows });
}

/** Current board as plain editable entries. */
function boardEntries(snap) {
  return snap.targetBoard.map((t) => ({
    name: t.name, position: t.position, tier: t.tier, maxPrice: t.maxPrice, note: t.note,
  }));
}

function renderPlan(snap) {
  const box = $('#plan');
  box.textContent = '';
  const p = snap.plan;

  if (!snap.targetBoard.length) {
    box.append(el('p', { className: 'empty' },
      'No targets yet. "Seed from CSV" builds a starting board from your valuations.'));
    return;
  }

  box.append(
    el('div', { className: 'numbers' }, [
      el('div', {}, [el('span', { className: 'k' }, 'Plan cost'), el('span', { className: 'v' }, money(p.plannedCost))]),
      el('div', {}, [el('span', { className: 'k' }, 'You have'), el('span', { className: 'v' }, money(p.budget))]),
      el('div', {}, [
        el('span', { className: 'k' }, p.feasible ? 'Headroom' : 'Short by'),
        el('span', { className: `v ${p.feasible ? 'under' : 'over'}` },
          money(p.feasible ? p.headroom : p.shortfall)),
      ]),
    ]),
    el('p', { className: 'hint' }, p.feasible
      ? `${p.plan.length} target${p.plan.length === 1 ? '' : 's'} fit your ${p.openSlots} open slot${p.openSlots === 1 ? '' : 's'}, `
        + `with ${money(p.reserve)} held back at minimum bid.`
      : `Your remaining targets cost ${money(p.required)} but you have ${money(p.budget)}. `
        + 'Drop a tier, cut a price, or plan to find value late.'),
  );

  if (p.unslotted.length) {
    box.append(el('p', { className: 'hint over' },
      `No roster slot left for: ${p.unslotted.map((t) => t.name).join(', ')}`));
  }
}

function renderTiers(snap) {
  const box = $('#tiers');
  box.textContent = '';
  if (!snap.targetBoard.length) return;

  const byTier = new Map();
  for (const t of snap.targetBoard) {
    if (!byTier.has(t.tier)) byTier.set(t.tier, []);
    byTier.get(t.tier).push(t);
  }
  const pressure = Object.fromEntries(snap.tiers.map((row) => [row.tier, row]));

  for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
    const rows = byTier.get(tier).sort((a, b) => (b.maxPrice ?? 0) - (a.maxPrice ?? 0));
    const info = pressure[tier] ?? {};

    const heading = el('h2', {}, `Tier ${tier}`);
    heading.append(el('span', {
      className: `tierbadge ${info.exhausted ? 'gone' : info.critical ? 'critical' : ''}`,
    }, info.exhausted ? 'gone' : `${info.open}/${info.total} left`));
    box.append(heading);

    const table = el('table', { className: 'grid targets' });
    const tbody = el('tbody');

    for (const t of rows) {
      const priceInput = el('input', {
        type: 'number', min: '0', className: 'price',
        value: t.maxPrice ?? '',
        disabled: t.status !== 'open',
      });
      // Commit on change, not on every keystroke, so a half-typed "4" of "45"
      // never briefly becomes the live ceiling on the Live tab.
      priceInput.addEventListener('change', () => {
        const entries = boardEntries(snap);
        const row = entries.find((e) => e.name === t.name && e.position === t.position);
        if (row) row.maxPrice = priceInput.value === '' ? null : Number(priceInput.value);
        saveTargets(entries);
      });

      const tierInput = el('input', {
        type: 'number', min: '1', className: 'tier', value: t.tier,
        disabled: t.status !== 'open',
      });
      tierInput.addEventListener('change', () => {
        const entries = boardEntries(snap);
        const row = entries.find((e) => e.name === t.name && e.position === t.position);
        if (row) row.tier = Number(tierInput.value) || 1;
        saveTargets(entries);
      });

      const status = t.status === 'won'
        ? el('span', { className: 'tag won', title: `you paid ${money(t.soldFor)}` }, `won ${money(t.soldFor)}`)
        : t.status === 'lost'
          ? el('span', {
            className: 'tag lost',
            title: `${t.wonBy} paid ${money(t.soldFor)}`
              + (t.overshoot != null ? ` (${t.overshoot >= 0 ? '+' : ''}${t.overshoot} vs your target)` : ''),
          }, `lost ${money(t.soldFor)}`)
          : el('button', { className: 'drop', title: 'remove from board' }, '×');

      if (t.status === 'open') {
        status.addEventListener('click', () => {
          saveTargets(boardEntries(snap).filter((e) => !(e.name === t.name && e.position === t.position)));
        });
      }

      // When auto-adjust is on, the effective price differs from what you
      // typed; show it so the override is visible rather than surprising.
      const effective = snap.autoAdjustTargets && t.effective != null && t.effective !== t.maxPrice
        ? el('span', { className: 'eff', title: 'inflation-adjusted' }, `→${money(t.effective)}`)
        : null;

      tbody.append(el('tr', { className: t.status }, [
        el('td', { title: t.name }, t.name),
        el('td', {}, el('span', { className: 'pos' }, t.position ?? '—')),
        el('td', { className: 'num' }, tierInput),
        el('td', { className: 'num' }, effective ? [priceInput, effective] : priceInput),
        el('td', { className: 'num', title: 'par value from your CSV' },
          t.parValue != null ? money(t.parValue) : '—'),
        el('td', {}, status),
      ]));
    }

    table.append(
      el('thead', {}, el('tr', {}, [
        el('th', {}, 'Player'), el('th', {}, 'Pos'), el('th', { className: 'num' }, 'Tier'),
        el('th', { className: 'num' }, 'Your $'), el('th', { className: 'num' }, 'Par'), el('th', {}, ''),
      ])),
      tbody,
    );
    box.append(table);
  }
}

function render(snap) {
  latest = snap;
  renderStatus(snap);
  renderAdvice(snap);
  renderPlan(snap);
  renderTiers(snap);
  $('#auto-adjust').checked = snap.autoAdjustTargets;
  renderHistory(snap);
  renderTeams(snap);
  renderMarket(snap);
  renderAlerts(snap);
}

// --- messaging --------------------------------------------------------------
const send = (msg) => browser.runtime.sendMessage(msg);

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === 'snapshot') render(msg.snapshot);
  return undefined;
});

// --- setup handlers ---------------------------------------------------------
const form = $('#config-form');

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const data = new FormData(form);
  const slotText = String(data.get('rosterSlots') ?? '').trim();

  // Accepts "QB,RB,RB,BN x6" as well as a bare comma list.
  let rosterSlots;
  if (slotText) {
    rosterSlots = slotText.split(',').flatMap((chunk) => {
      const m = /^\s*([A-Za-z]+)\s*(?:x\s*(\d+))?\s*$/.exec(chunk);
      if (!m) return [];
      return Array.from({ length: Number(m[2] ?? 1) }, () => m[1].toUpperCase());
    });
  }

  send({
    kind: 'set-config',
    config: {
      numTeams: Number(data.get('numTeams')),
      budget: Number(data.get('budget')),
      minBid: Number(data.get('minBid')),
      myTeamId: String(data.get('myTeamId') ?? '').trim() || null,
      aggressiveness: Number(data.get('aggressiveness')),
      ...(rosterSlots?.length ? { rosterSlots } : {}),
    },
  });
});

form.aggressiveness.addEventListener('input', (ev) => {
  $('#aggr-value').textContent = ev.target.value;
});


$('#add-target').addEventListener('click', () => {
  const name = prompt('Player name?');
  if (!name) return;
  const position = prompt('Position? (QB/RB/WR/TE/K/DST)');
  if (!position) return;
  const tier = Number(prompt('Tier? (1 = top)', '1')) || 1;
  const raw = prompt('Your max price? (blank = use par value)', '');
  const maxPrice = raw === '' || raw == null ? null : Number(raw);

  send({
    kind: 'set-targets',
    targets: [...boardEntries(latest), { name, position, tier, maxPrice }],
  });
});

$('#seed-targets').addEventListener('click', async () => {
  const result = await send({ kind: 'seed-targets', options: { topN: 60, tierCount: 6 } });
  if (!result.count) {
    alert('No valuations loaded yet — import a CSV in Setup first.');
  }
});

$('#auto-adjust').addEventListener('change', (ev) => {
  send({ kind: 'set-auto-adjust', value: ev.target.checked });
});

$('#csv-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const csv = await file.text();
  const result = await send({ kind: 'load-valuations', csv });
  $('#csv-status').textContent = `${result.count} players loaded`
    + (result.problems.length ? ` — ${result.problems.join('; ')}` : '');
});

function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

$('#export-log').addEventListener('click', async () => {
  download('draft-log.json', await send({ kind: 'get-log' }));
});

$('#export-capture').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const capture = await browser.tabs.sendMessage(tab.id, { kind: 'export-capture' });
  download('ws-capture.json', capture);
});

$('#reset').addEventListener('click', () => {
  if (confirm('Discard the current draft log? This cannot be undone.')) {
    send({ kind: 'reset' });
  }
});

$('#manual-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const data = new FormData(ev.target);
  send({
    kind: 'manual-event',
    type: EventType.SOLD,
    payload: {
      playerName: String(data.get('playerName')).trim(),
      position: String(data.get('position')).trim().toUpperCase(),
      teamId: String(data.get('teamId')).trim(),
      teamName: String(data.get('teamId')).trim(),
      price: Number(data.get('price')),
    },
  });
  ev.target.reset();
});

// --- boot -------------------------------------------------------------------
(async () => {
  const snap = await send({ kind: 'get-snapshot' });
  const c = snap.config;
  form.numTeams.value = c.numTeams;
  form.budget.value = c.budget;
  form.minBid.value = c.minBid;
  form.myTeamId.value = c.myTeamId ?? '';
  form.aggressiveness.value = c.aggressiveness ?? 0.5;
  form.rosterSlots.value = c.rosterSlots.join(',');
  $('#aggr-value').textContent = form.aggressiveness.value;
  render(snap);
})();

// Keeps the "last event Ns ago" tooltip honest while the draft is quiet.
setInterval(() => { if (latest) renderStatus(latest); }, 5000);
