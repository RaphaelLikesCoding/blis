# Auction Draft Tracker

A Firefox add-on that watches a fantasy football **auction** draft room and
turns it into a live analytical layer: who was taken, for how much, what every
team has left, what they still need, and what the player on the block is
actually worth *in this market* rather than in the one your rankings assumed.

Read-only by design. It observes and advises; it never bids.

---

## Why it works this way

**It reads the DOM, not the screen.** A browser extension already lives inside
the page, so pixel-scraping and OCR are a last resort, not the design. Three
detection layers, best first:

| Layer | How | Confidence | Notes |
|---|---|---|---|
| `ws` | wraps `window.WebSocket` in the page world and mirrors frames | 1.00 | exact player ids, prices, teams; instant |
| `dom` | `MutationObserver` over the draft board | 0.85 | works anywhere, breaks on redesigns |
| `ocr` | canvas fallback (not yet implemented) | 0.55 | only if the room renders to `<canvas>` |

Both implemented layers run **at the same time**. The store deduplicates, so
the DOM layer silently covers whatever the WebSocket mapping misses instead of
leaving a hole you notice only after the draft.

**State is an append-only event log.** Every observation is an event; all
budgets, rosters and analytics are a pure function of that log
(`src/core/reducer.js`). That buys four things that matter on draft day:

- **Replay** — rehearse against a recorded draft (`npm run replay`)
- **Undo** — a bad parse is retracted or corrected, not surgically unwound
- **Recovery** — refresh the draft room mid-auction and lose nothing
- **Post-mortem** — export the log and study what the league actually paid

**Low-confidence events are quarantined, not applied.** Anything the adapter
was unsure about lands in a review queue in the sidebar with Confirm/Discard
buttons. Silence never means "fine" — unresolved problems surface as alerts.

---

## The analytics

The tracking is table stakes. These are the numbers worth having:

**Inflation** — `remaining money ÷ remaining par value`, after removing the
$1-per-open-slot floor that can never chase value (the "discretionary" form).
Above 1.0 you must overpay or go home; below 1.0 there are bargains ahead and
patience pays. This is the single most valuable live number in an auction and
nobody tracks it by hand.

**Max bid per team** — `money left − $1 × (other open slots)`. The real ceiling
a rival can reach, which is usually far below their raw remaining budget. The
Teams tab sorts by it, so you can see at a glance who can actually fight you.

**Positional scarcity** — startable players remaining versus starting slots the
league still has to fill, with replacement level derived from your roster
settings (flex demand split across eligible positions). Below 1.0 means a run
is coming.

**Tier cliff** — the drop from the best available at a position to the next
one. A big cliff is what justifies paying over par: losing that player costs
you the whole gap, not a dollar.

**Budget pressure** — which teams are nearly locked into $1 bids. Your cue to
nominate expensive players you *don't* want while the field can still pay.

**Bid advice** — combines the above into `walk-away` (par × inflation, the
disciplined number) and `ceiling` (walk-away + a configurable slice of the tier
cliff), both hard-capped by your own max bid so it never advises a bid you
cannot legally make. An explicit price target on your board replaces the
market-derived number entirely — see below.

---

## The target board

Valuations say what a player is worth to the market. Targets say what he is
worth **to you** — a different question, and the one you actually bid off.

**Tiers** group players who are interchangeable *to you*. The point is that you
need N players from a tier, not one specific name, so losing one only matters
when the tier runs dry. The board flags each tier as healthy, **critical** (two
or fewer names left) or **exhausted**.

**Price targets** are yours and override the market-derived ceiling. Set $42 on
a player and the Live tab will say PASS at $43 no matter what the CSV thinks.
Every price and tier on the board is an editable cell — retuning mid-draft is
one click, and it saves immediately. Leave a price blank to fall back to par.

Optional **adjust for inflation** scales your targets by the live market rate,
because a $40 target in a market running 1.2× is really a $48 target — holding
the nominal number while everything inflates means quietly targeting a worse
player. Off by default; when on, the adjusted figure is shown next to your
typed one so the override is visible rather than surprising.

**Plan feasibility** is the number that earns the tab. It walks your open
targets in tier order, fits each into a remaining roster slot, and compares the
total against the money you actually have:

```
plan: $127 of targets for 6 of 13 open slots, $99 available -- SHORT BY $35
```

Discovering at $12 remaining that your plan needed $60 is the classic auction
death. This makes it impossible to walk into.

Seed a starting board from your CSV in one click (it uses the export's own tier
column when there is one, otherwise bands by value), then edit. Seeding merges
rather than replaces, so it never wipes prices you have already tuned.


---

## Install (temporary, for development)

```
about:debugging → This Firefox → Load Temporary Add-on → pick manifest.json
```

Opens as a **sidebar** (`Ctrl+Shift+Y` or View → Sidebar), which is what you
want next to a draft room — no overlay fighting the page for space.

Requires Firefox 128+ (MV3 background modules). No build step, no bundler, no
`npm install` — it is plain ES modules that load directly.

## Set up before draft day

1. **Sidebar → Setup → League** — teams, budget, min bid, roster slots
   (`QB,RB,RB,WR,WR,WR,TE,FLEX,K,DST,BN x6`), and **your team id exactly as the
   draft room spells it**.
2. **Setup → Valuations** — import a CSV with player / position / auction value
   columns. FantasyPros exports work as-is; headers are alias-matched, and
   `RB1`-style positions are split into position + positional rank. Values are
   **rescaled to your league's total money**, so a $200/12-team sheet is
   corrected automatically for a $300/10-team league.
3. **Calibrate against a mock draft** — see below. Do not skip this.

## Calibrating on a CBS Salary Cap mock draft

The selectors in `src/adapters/profiles.js` are **provisional guesses** written
without access to a live auction room, and every platform reskins between
seasons. This takes about two minutes and turns them into verified ones.

Open a **CBS Salary Cap Mock Draft** — never calibrate in your real league —
and paste `tools/selftest.js` into the browser console:

```js
__auctionSelfTest()      // check every selector against the live page
```

You get a table with one row per selector and a verdict:

| Status | Meaning |
|---|---|
| `OK` | resolved, with a sample of what it matched |
| `FAIL` | the container exists but this selector matched nothing — **wrong, fix it** |
| `INVALID` | not valid CSS |
| `EMPTY` | nothing to match yet; it tells you which draft action would populate it |
| `NO-SCOPE` | its parent container is absent, so it had nowhere to look — not broken |

That `FAIL` / `EMPTY` distinction is the point: a mid-draft lull with no player
on the block is not the same as a broken selector, and conflating them sends you
chasing selectors that are already correct.

Then nominate a player, run the bidding up, let one sale complete, and re-run.
It prints the exact events the adapter would emit, warns about sales parsed
without a position (those never auto-apply), and ends with a pasteable selector
block for the sidebar's Advanced panel.

Also confirm the room is observable at all:

```js
__auctionSelfTestLive()  // watch 45s of live bidding
```

If it reports fewer than two distinct states while bids are visibly moving, the
room renders through canvas or shadow DOM and the DOM layer cannot see it — the
WebSocket capture is then the only viable path.

To hunt for replacements for anything that failed, `tools/calibrate.js`:

```js
__auctionCalibrate()                  // survey candidate selectors
__auctionCalibrate('Bijan Robinson')  // locate a known player name
__auctionWatch()                      // log the most-mutated nodes for 30s
```

Better still, get the WebSocket mapping right — it beats every selector:

1. Run a mock draft with the add-on loaded.
2. **Setup → Export WS capture**.
3. Feed the capture to `guessMapping()` in `src/adapters/ws.js` for candidate
   field paths, confirm them by eye, and save the mapping to
   `browser.storage.local` under `mapping`.

Until a mapping exists the WS layer stays in **RECORD** mode (observe and
capture only) and the DOM layer does the work.

## Rehearsing

```bash
npm install          # linkedom, for the DOM tests only — the add-on ships dependency-free
npm test             # 124 tests

# rehearse a full draft, or freeze it mid-auction
npm run replay -- fixtures/sample-draft.json fixtures/sample-values.csv
npm run replay -- fixtures/sample-draft.json fixtures/sample-values.csv --at 300

# rehearse your target board against it
npm run replay -- fixtures/sample-draft.json fixtures/sample-values.csv \
  --at 150 --targets fixtures/sample-targets.json --me team-4
```

The last one prints exactly what the Targets tab would show:

```
target board
  tier 1:  0/6 open  won 0 ($0)   lost 6   EXHAUSTED
  tier 2:  1/6 open  won 2 ($41)  lost 3   CRITICAL
  tier 3:  5/6 open  won 0 ($0)   lost 1

plan: $127 of targets for 6 of 13 open slots, $99 available -- SHORT BY $35
```

`tools/simulate.js` generates a deterministic, internally-consistent 12-team
$200 auction (192 sales, every team landing on exactly the cap) plus the
matching valuation CSV. The replay tests assert on it end to end: no player
drafted twice, no team overspent, every dollar accounted for, and reducing a
prefix of the log equals replaying to that point — the property page-refresh
recovery depends on.

## Layout

```
src/core/        pure logic, no DOM, no browser APIs — everything tested
  events.js        event vocabulary + validation
  reducer.js       log -> state (pure, total, deterministic)
  store.js         append-only log + dedup + subscribe
  analytics.js     inflation, scarcity, cliffs, bid advice
  valuations.js    CSV import + league rescaling
  targets.js       tiers, price targets, plan feasibility
  players.js       name normalization + fuzzy resolution
  config.js        roster slots, flex eligibility, replacement level
src/adapters/    platform seam — the only place site knowledge lives
src/content/     content script + page-world WebSocket tap
src/background/  owns the store, persists to storage
src/sidebar/     view layer only; computes nothing
tools/           simulate, replay, calibrate, selftest
```

`src/core/` has no browser dependency, which is why the whole analytical layer
runs under `node --test` with no DOM shim.

## Status

**Working and tested (124 tests):** the core, analytics, the target board,
valuation import, store/persistence, sidebar, DOM adapter, WS tap and record
mode, the self-test tool, replay and simulation.

The DOM adapter is driven through a real DOM (linkedom) against
`fixtures/cbs-draft-room.html` — a CBS-shaped room deliberately built messy
(header rows, `$58` / `58` / ` $7 ` price formats, a suffixed name, a `D/ST`
alias, a row with no position) — and the full chain from DOM mutation to league
state is asserted end to end.

**Not verified: that the CBS selectors match the live site.** The fixture is a
reconstruction, not a capture; it proves the adapter handles a room of that
*shape*, not that CBS uses those class names. Nothing runnable offline can prove
that — `__auctionSelfTest()` in a real mock draft is what closes the gap, and it
is built to say so loudly rather than pass quietly.

Also provisional: the WS field mappings, which need a real capture, so the
WebSocket layer ships in record-only mode. The OCR layer is designed for but not
implemented — only needed if a platform renders its draft board to canvas.

## A note on scope

This tool observes your own draft and gives you advice. It does not place bids,
automate any interaction, or send anything anywhere — all state stays in
`browser.storage.local`. Keep it that way: auto-bidding would put you crosswise
with every platform's terms of service.
