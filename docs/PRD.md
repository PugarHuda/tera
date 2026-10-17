# Tera — Product Requirements Document

> *Tera* (Indonesian): to officially calibrate a measuring instrument.
> Tera calibrates your pricing: see exactly what every customer will be charged before you change it — proven to match Stripe on every pull request.

Status: v0.1 draft · Owner: hudapugar@gmail.com · Hackathon: TestSprite Season 4

---

## 1. Problem

SaaS founders are afraid to touch pricing. A price change, a mid-cycle upgrade, a coupon or a tax rule produces invoices nobody previewed. Stripe executes billing; it does not let you *simulate* it across customers and time before you commit. Mistakes are found by customers, on their card statements.

## 2. Product

Tera is a pricing simulator that sits **on top of Stripe** (it never moves money):

1. **Pricing Builder** — define plans and prices.
2. **Customer Timeline Simulator** — run a virtual customer through events and get every invoice, to the cent.
3. **Price Migration Planner** — preview the impact of a price change on an existing customer base.
4. **Stripe Parity Check** — replay any scenario in Stripe test mode and diff the result line by line.
5. **Push to Stripe** — create the validated products/prices/coupons in Stripe.
6. **Shareable Report** — public read-only link to a simulation.

### Users
- **Founder / PM** — designs pricing, wants confidence before launch.
- **Engineer** — integrates billing, wants a reference for expected invoices.

## 3. Domain model

| Entity | Fields |
|---|---|
| Plan | id, name, prices[] |
| Price | id, currency, unit_amount (minor units), interval (`month`/`year`), billing_scheme (`per_unit`/`tiered`), usage_type (`licensed`/`metered`), tiers[] |
| Coupon | code, percent_off \| amount_off+currency, duration (`once`/`repeating`/`forever`), duration_in_months |
| TaxRate | percentage, behavior (`inclusive`/`exclusive`) |
| Customer (virtual) | id, name, currency |
| Event | at (ISO-8601 UTC), type, payload |
| Invoice | period_start, period_end, lines[], subtotal, discount, tax, total |
| InvoiceLine | description, amount (minor units), proration (bool), period |

Event types: `subscribe`, `start_trial`, `change_price`, `change_quantity`, `apply_coupon`, `report_usage`, `cancel_at_period_end`, `advance_to`.

## 4. Billing rules (the source of truth for the engine and the tests)

All rules mirror Stripe's documented behavior. Any rule marked **VERIFY** must be confirmed against Stripe test mode before its golden values are frozen.

### R1 — Money
- All amounts are integers in the currency's **minor unit** (USD cents, EUR cents). Zero-decimal currencies (JPY, KRW) use the major unit (¥3000 → `3000`).
- Each invoice line is rounded to an integer **independently**, then summed. Totals are never rounded again.
- Rounding mode: round half away from zero. **VERIFY** (no golden scenario depends on an exact .5 until verified).

### R2 — Billing periods
- The billing anchor is the subscription start. A monthly period runs from day *D* to day *D* of the next month (Jan 1 → Feb 1 = 31 days; Feb 1 → Mar 1 = 28 days, 29 in leap years).
- Time is measured in seconds. All golden scenarios use 00:00:00 UTC timestamps, so the fraction of a period equals the fraction of days.

### R3 — Proration (price or quantity change mid-period)
Two lines are generated, each rounded separately:
- **Unused time credit:** `−round(old_amount × remaining / period)`
- **Remaining time charge:** `+round(new_amount × remaining / period)`

where `old_amount`/`new_amount` = unit_amount × quantity.
- `proration_behavior = create_prorations` (default): lines are added to the **next** invoice.
- `proration_behavior = always_invoice`: lines are invoiced **immediately**.
- Changing the **interval** (month → year) resets the billing anchor to the change time and invoices immediately: unused-time credit + full new-period charge.

### R4 — Trials
- A trial produces a $0 invoice at start. The first paid period starts when the trial ends and becomes the new billing anchor.

### R5 — Coupons
- `percent_off` applies to the invoice subtotal (including proration lines). **VERIFY** for proration lines.
- `amount_off` is capped at the subtotal; any remainder is lost (not carried over).
- `once` = first invoice only; `repeating` = first *N* monthly invoices; `forever` = all invoices.
- A coupon code applied to the same subscription more than once has **no additional effect** (idempotent, including page reloads and double submits).

### R6 — Tax
- Tax is computed **after** discounts.
- Exclusive: `tax = round(taxable × rate)`, `total = taxable + tax`.
- Inclusive: `tax = round(taxable × rate / (1 + rate))`, `total = taxable`.

### R7 — Metered, graduated tiers
- Each tier charges its own units at its own rate: `Σ units_in_tier × tier_rate`, rounded once per line.

### R8 — Cancellation
- `cancel_at_period_end`: no proration and no further invoices; the status becomes `canceled` at period end.

### R9 — Price migration
- Changing a price with `grandfather = true` leaves existing subscribers on the old price; MRR delta = 0 for them.
- With `grandfather = false`, existing subscribers move at their **next renewal** (no proration); MRR delta = Σ (new − old) × quantity.

### R12 — Billing mode
- Tera models Stripe's **classic** billing mode. New Stripe subscriptions default to *flexible* mode, where a monthly → yearly change does not reset the anchor; the parity replay pins `billing_mode: classic`.
- Invoices created during an API call (subscription creation, `always_invoice`, interval change) are finalized immediately, so a coupon applied in the same instant affects the **next** invoice (golden S11, corrected after the Stripe replay contradicted the hand derivation).

## 5. Invariants (must hold for every simulation)

- **I1** `total == Σ lines − discount + tax_exclusive`, and every amount is an integer.
- **I2** An unused-time credit never exceeds what was paid for that period.
- **I3** A `once` coupon discounts exactly one invoice, regardless of reloads or repeated applications.
- **I4** Zero-decimal currencies never display a decimal separator.
- **I5** Simulating the same timeline twice yields byte-identical invoices (deterministic).
- **I6** Invoice periods are contiguous with no gaps or overlaps.

## 6. Functional requirements

> **Shipped status.** Each FR below is tagged **[SHIPPED]** or **[PLANNED]**. Only test [SHIPPED] requirements; [PLANNED] ones do not exist in the app yet.
>
> Live app: `/` = Timeline Simulator (FR2) + Shareable link (FR6), `/parity` = Stripe parity (FR4/FR5), `/migrate` = Migration Planner (FR3), `/api/*` = Public API (FR7). There is no login.

### FR1 Pricing Builder [PLANNED]
- Create, edit and delete plans with prices in USD, EUR, GBP and JPY.
- Validation: amount > 0, an integer in minor units; JPY rejects decimals; tiers are contiguous.

### FR2 Timeline Simulator [SHIPPED]
- The page loads with golden scenario S05 selected. A "Load scenario" dropdown replaces the timeline with any golden scenario (S01–S23).
- Each event row has a date, an event type and the fields relevant to that type (price, quantity, coupon, tax rate, trial days, proration behavior). Rows can be edited, added ("+ Add event") and deleted (✕).
- Invoices recompute instantly on every change; there is no submit button.
- If events are not in chronological order, an error alert is shown instead of invoices.
- Unknown prices or events before a subscribe show an error alert.
- Each invoice shows its date, period, lines (proration lines carry a "proration" badge), subtotal, discount (if any), tax (if any) and a bold total.
- While a loaded scenario is unedited, a badge shows "✅ Matches golden expected" when every invoice total equals the golden expected total.
- A locale dropdown (en-US, de-DE, ja-JP, en-GB) reformats amounts: `$103.20` in en-US, `103,20 $` in de-DE; JPY never shows decimals (`¥10,419`).
- Reference values: S05 → invoice 1 `$29.00`, invoice 2 `$103.20` (lines −$14.03, $38.23, $79.00). S10 (SAVE20 once) → first invoice discounted by 20 %, second not. S22 → status `canceled`.

### FR3 Migration Planner [SHIPPED]
- Page `/migrate`. Inputs: current monthly price (USD), new monthly price (USD), a "Grandfather existing customers" checkbox, and seats per customer (comma separated).
- Output, recomputed instantly: customers affected, MRR before, MRR after, MRR change (signed).
- Default inputs $29 → $39, seats `1, 1, 3`: affected 3, MRR $145.00 → $195.00, change +$50.00. With grandfathering: affected 0, change +$0.00.
- Non-positive prices or non-integer seat counts show an error alert.

### FR4 Stripe Parity Check [SHIPPED]
- `scripts/verify-golden.mts` replays every golden timeline in a Stripe **test-mode** account using test clocks (classic billing mode, API `2026-09-30.endive`), fetches Stripe's invoices and diffs them line by line against Tera's engine (date, currency, line amounts, subtotal, discount, tax, total). Matching scenarios are marked `"status": "verified"`; the evidence (Stripe invoice ids, test clock, customer) is committed under `golden/parity/`.
- Page `/parity` lists every timeline scenario with a ✅ Match / ❌ Diff / — Not replayable badge and the summary "N / M scenarios match Stripe to the cent"; expanding a row shows Tera and Stripe invoices side by side; "Re-run live in Stripe" replays it now.
- `GET /api/parity` returns the recorded evidence; `POST /api/parity {"scenario":"S05"}` replays one golden scenario live (golden ids only; one live run per 30 s → 429).
- The Stripe key is server-side only (`STRIPE_SECRET_KEY`, test mode enforced) and never returned to the client.
- Metered usage (S23) is not replayed yet: Stripe usage-based billing needs meter events against the test clock.

### FR5 Push to Stripe [SHIPPED]
- The parity run first pushes Tera's catalog to Stripe idempotently: prices by `lookup_key` `tera_<id>`, coupons with id `TERA_<code>`, tax rates by display name `tera_<id>`. Re-running never duplicates objects.

### FR6 Shareable link [SHIPPED]
- A "Copy share link" button on `/` encodes the current timeline into the URL (`/?t=<base64url JSON>`), shows the link in a read-only field and copies it to the clipboard.
- Opening that link restores the exact same timeline and therefore the exact same invoices. If it is exactly a golden scenario, that scenario is selected and the golden badge shows; otherwise the dropdown shows "Custom (shared link)" and no badge is shown.
- `/?s=S10` opens a golden scenario directly (case-insensitive). An unknown id falls back to S05.
- A corrupted `t` value never crashes the page: an alert reads "This shared link is invalid or corrupted, so the default scenario was loaded instead." and S05 is loaded.

### FR7 Public API [SHIPPED] (tested directly by TestSprite's API suite)
- `POST /api/simulate` — body `{ timeline, catalog?, locale? }`. `catalog` defaults to the golden catalog. Returns `{ status, canceled_at, invoices[] }`; each invoice has `date, currency, period_start, period_end, lines[{description, amount, proration}], subtotal, discount, tax, total, total_display`.
- `POST /api/migrate` — body `{ unit_amount, new_unit_amount, grandfather, customers[] }` → `{ affected, mrr_before, mrr_after, mrr_delta }`.
- `GET /api/scenarios` — list of `{ id, title, status, rules }`. `GET /api/scenarios/:id` (case-insensitive) — the scenario with its `timeline` and hand-derived `expect`, plus the `catalog`. Unknown id → 404.
- Errors: malformed JSON or invalid fields → **400** `{ error }`; unknown price/coupon/tax rate or an event before subscribe → **422** `{ error }`.
- Contract: for every golden scenario, posting its `timeline` to `/api/simulate` must return invoices whose `date`, line `amount`s and `total` equal its `expect` exactly.
- Documented in an OpenAPI spec at `/api/openapi.json`.

## 7. Non-functional
- The simulation engine is a pure TypeScript module: no I/O, deterministic, unit-testable.
- p95 `/api/simulate` latency is under 300 ms for 50 events.
- Every pull request gets a Vercel preview deployment, and TestSprite UI + API suites run against it and **block merge**.
- Accessibility: keyboard-operable builder and timeline, labelled inputs.

## 8. Testing strategy

| Layer | What | Where |
|---|---|---|
| Unit | Engine against `golden/scenarios.json` | CI, every push |
| API E2E | TestSprite API suite on `/api/simulate` (golden scenarios + invariants) | Every PR, blocking |
| UI E2E | TestSprite UI suite: build plan → run timeline → assert invoice amounts | Every PR, blocking |
| Parity | Golden scenarios replayed in Stripe test mode; diff must be empty | Nightly + on demand |

Golden values are **never** produced by Tera's own engine. They are derived by hand from the rules above and frozen only after Stripe parity confirms them (`status: "verified"`). As of 2026-10-17, 22/22 replayable scenarios are verified; S11 was corrected because Stripe disagreed with the hand derivation.

## 9. Out of scope (v1)
Real payments, dunning, multiple subscriptions per customer, mid-period tax changes, invoice PDFs.

## 10. Success criteria (hackathon)
- All golden scenarios are `verified` against Stripe.
- 20+ feature PRs, each gated by TestSprite with merge blocking enabled.
- At least 3 PRs where TestSprite caught a real billing bug, followed by a fix commit and a green check.
