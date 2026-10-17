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
- Rounding mode: round half away from zero. Stripe does not document its rounding mode; all 26 replayed scenarios (prorations, percent coupons, inclusive/exclusive tax, graduated tiers with decimal unit amounts) match it to the cent.

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
- `percent_off` applies only to **non-proration** lines. Proration lines are priced already discounted and are not discounted again (Stripe marks them `discountable=false`; docs.stripe.com/billing/subscriptions/prorations). Golden S28.
- The **unused-time credit** refunds the rate the current amount was actually charged at: the period invoice's `percent_off` (even a `once` coupon that is now used up, S30), or the rate of the latest proration charge (S33). A coupon applied mid-period does not reduce the credit for time already paid in full (S34).
- The **remaining-time charge** is priced at the `percent_off` coupon still active at the change, and becomes the rate later credits refund.
- `amount_off` is capped at the discountable (non-proration) subtotal.
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

### R10 — Customer credit balance
- An invoice whose total is negative (e.g. a downgrade with `always_invoice`) charges nothing: `amount_due = 0` and the negative total becomes customer credit.
- Each invoice records `starting_balance` (≤ 0) and `amount_due = max(0, total + starting_balance)`; leftover credit carries to the next invoice.

### R11 — Rejected timelines (Stripe rejects these; the API returns 422)
- A second `subscribe`/`start_trial` while a subscription is active; any event after the subscription was canceled.
- `change_price` to a price in another currency; an `amount_off` coupon whose currency differs from the subscription's.
- `report_usage` on a licensed (non-metered) price.
- A price or quantity change during a trial does not prorate (R4): the new terms bill when the trial ends.

### R12 — Billing mode
- Tera models Stripe's **classic** billing mode. New Stripe subscriptions default to *flexible* mode, where a monthly → yearly change does not reset the anchor; the parity replay pins `billing_mode: classic`.
- Invoices created during an API call (subscription creation, `always_invoice`, interval change) are finalized immediately, so a coupon applied in the same instant affects the **next** invoice (golden S11, corrected after the Stripe replay contradicted the hand derivation).

### R13 — Changing the price of an item
- Like a Stripe subscription item update, `change_price` without a `quantity` resets the quantity to **1** (S31); pass `quantity` to keep seats (S32). Found by a live "Verify in Stripe" replay of a custom timeline.

## 5. Invariants (must hold for every simulation)

- **I1** `total == Σ lines − discount + tax_exclusive`, and every amount is an integer.
- **I2** An unused-time credit never exceeds what was paid for that period (including earlier proration charges in the same period, S33).
- **I3** A `once` coupon discounts exactly one invoice, regardless of reloads or repeated applications.
- **I4** Zero-decimal currencies never display a decimal separator.
- **I5** Simulating the same timeline twice yields byte-identical invoices (deterministic).
- **I6** Invoice periods are contiguous with no gaps or overlaps, and `amount_due` is never negative.

## 6. Functional requirements

> **Shipped status.** Each FR below is tagged **[SHIPPED]** or **[PLANNED]**. Only test [SHIPPED] requirements; [PLANNED] ones do not exist in the app yet.
>
> Live app: `/builder` = Pricing Builder (FR1), `/` = Timeline Simulator (FR2) + Shareable link (FR6), `/parity` = Stripe parity (FR4/FR5), `/reference` = API reference (FR9), `/mcp-setup` = MCP server (FR8), `/migrate` = Migration Planner (FR3), `/api/*` = Public API (FR7). There is no login.

### FR1 Pricing Builder [SHIPPED]
- Page `/builder`: create, edit and delete prices (USD, EUR, GBP, JPY; monthly or yearly), coupons (% or amount off; once, repeating with months, forever) and tax rates (exclusive or inclusive). It starts from the reference catalog; "Reset to reference catalog" restores it. Drafts survive a reload (browser storage, convenience only).
- Amounts are typed in major units and stored in minor units. JPY rejects decimals ("JPY has no minor unit, so the amount cannot have decimals"); duplicate price ids, non-positive amounts and invalid ids are reported, and the same validator as the API runs on the whole catalog. A valid catalog shows "Catalog is valid: N prices, M coupons, K tax rates."
- "Simulate with this catalog" opens `/?c=<catalog>` with a subscribe on the first price; share links keep the catalog. Golden scenarios are hidden for custom catalogs and a banner names the custom catalog.
- "Push to Stripe (test mode)" calls `POST /api/stripe/push` (FR5) and lists the Stripe ids it created or reused.

### FR2 Timeline Simulator [SHIPPED]
- The page loads with golden scenario S05 selected. A "Load scenario" dropdown replaces the timeline with any golden scenario (S01–S34).
- Each event row has a date, an event type and the fields relevant to that type (price, quantity, coupon, tax rate, trial days, proration behavior). Rows can be edited, added ("+ Add event") and deleted (✕).
- Invoices recompute instantly on every change; there is no submit button.
- If events are not in chronological order, an error alert is shown instead of invoices.
- Unknown prices or events before a subscribe show an error alert.
- Each invoice shows its date, period, lines (proration lines carry a "proration" badge), subtotal, discount (if any), tax (if any) and a bold total.
- While a loaded scenario is unedited, a badge shows "✅ Matches golden expected" when every invoice total equals the golden expected total.
- A locale dropdown (en-US, de-DE, ja-JP, en-GB) reformats amounts: `$103.20` in en-US, `103,20 $` in de-DE; JPY never shows decimals (`¥10,419`).
- "Verify in Stripe" replays the current timeline in a fresh Stripe test clock and shows "✅ Matches Stripe" with the test clock id, or each differing field (Tera vs Stripe).
- "Export CSV (minor units)" downloads one row per invoice (date, currency, lines, subtotal, discount, tax, total, starting balance, amount due); text cells are neutralised against spreadsheet formula injection.
- Reference values: S05 → invoice 1 `$29.00`, invoice 2 `$103.20` (lines −$14.03, $38.23, $79.00). S10 (SAVE20 once) → first invoice discounted by 20 %, second not. S22 → status `canceled`.

### FR3 Migration Planner [SHIPPED]
- Page `/migrate`. Inputs: current price, new price (USD), billing interval (monthly, or annual where MRR = price ÷ 12 per customer, rounded per customer), a "Grandfather existing customers" checkbox, and the customer base.
- Customer base: a bare list of seat counts (`1, 1, 3`) or a CSV `name,seats` (header optional, quoted names allowed), typed, pasted, loaded with "Load sample customers" or imported with "Import CSV file".
- Output, recomputed instantly: customers affected (customers whose MRR changes), MRR before, MRR after, MRR change (signed), and a "Who pays more" table per customer sorted by change, exportable with "Export CSV".
- Default inputs $29 → $39, seats `1, 1, 3`: affected 3, MRR $145.00 → $195.00, change +$50.00. With grandfathering: affected 0, change +$0.00.
- Annual reference (golden S29): $290/yr → $390/yr, acme 2 seats + globex 1 seat → MRR $72.50 → $97.50 (+$25.00); acme +$16.67, globex +$8.33.
- Non-positive prices show "Prices must be positive amounts."; a bad seat count in the bare list shows "Seat counts must be positive whole numbers."; bad CSV rows are reported with their line number.

### FR4 Stripe Parity Check [SHIPPED]
- `scripts/verify-golden.mts` replays every golden timeline in a Stripe **test-mode** account using test clocks (classic billing mode, API `2026-09-30.endive`), fetches Stripe's invoices and diffs them line by line against Tera's engine (date, currency, line amounts, subtotal, discount, tax, total, starting_balance, amount_due). Matching scenarios are marked `"status": "verified"`; the evidence (Stripe invoice ids, test clock, customer) is committed under `golden/parity/`.
- Page `/parity` lists every timeline scenario with a ✅ Match / ❌ Diff / — Not replayable badge and the summary "N / M scenarios match Stripe to the cent"; expanding a row shows Tera and Stripe invoices side by side; "Re-run live in Stripe" replays it now.
- `GET /api/parity` returns the recorded evidence; `POST /api/parity {"scenario":"S05"}` replays one golden scenario live (golden ids only; one live run per 30 s → 429).
- The Stripe key is server-side only (`STRIPE_SECRET_KEY`, test mode enforced) and never returned to the client.
- Metered usage is replayed with a Stripe **Meter** (`tera_api_calls`, sum aggregation) and a graduated tiered price; meter events carry the test clock's time and the replay waits for Stripe's aggregation before the period closes (S23).

### FR5 Push to Stripe [SHIPPED]
- `POST /api/stripe/push {catalog}` validates the catalog (400 on invalid input) and creates or reuses its Stripe objects; 10 s cooldown (429).
- The parity run first pushes Tera's catalog to Stripe idempotently: prices by `lookup_key`, coupons by id and tax rates by display name, each keyed as `<id>_<sha256 of its definition>`: re-running never duplicates objects, and a changed definition (e.g. starter_m at $39) creates a new Stripe object instead of silently reusing the old $29 price.

### FR6 Shareable link [SHIPPED]
- A "Copy share link" button on `/` encodes the current timeline into the URL (`/?t=<base64url JSON>`), shows the link in a read-only field and copies it to the clipboard.
- Opening that link restores the exact same timeline and therefore the exact same invoices. If it is exactly a golden scenario, that scenario is selected and the golden badge shows; otherwise the dropdown shows "Custom (shared link)" and no badge is shown.
- `/?s=S10` opens a golden scenario directly (case-insensitive). An unknown id falls back to S05.
- A corrupted `t` value never crashes the page: an alert reads "This shared link is invalid or corrupted, so the default scenario was loaded instead." and S05 is loaded.

### FR7 Public API [SHIPPED] (tested directly by TestSprite's API suite)
- `POST /api/simulate` — body `{ timeline, catalog?, locale? }`. `catalog` defaults to the golden catalog. Returns `{ status, canceled_at, invoices[] }`; each invoice has `date, currency, period_start, period_end, lines[{description, amount, proration}], subtotal, discount, tax, total, starting_balance, amount_due, total_display`. Reference: S27 (downgrade, always_invoice) → invoice 2 total −2420 with amount_due 0; invoice 3 starting_balance −2420, amount_due 480.
- `POST /api/migrate` — body `{ unit_amount, new_unit_amount, grandfather, customers[], interval? }` where a customer is a seat count or `{ name, seats }` → `{ affected, mrr_before, mrr_after, mrr_delta, per_customer[] }`.
- `GET /api/scenarios` — list of `{ id, title, status, rules }`. `GET /api/scenarios/:id` (case-insensitive) — the scenario with its `timeline` and hand-derived `expect`, plus the `catalog`. Unknown id → 404.
- Errors: malformed JSON or invalid fields → **400** `{ error }`; unknown price/coupon/tax rate, an event before subscribe, or any R11 rejection → **422** `{ error }`.
- Contract: for every golden scenario, posting its `timeline` to `/api/simulate` must return invoices whose `date`, line `amount`s and `total` equal its `expect` exactly.
- Documented in an OpenAPI spec at `/api/openapi.json`.
- `POST /api/parity` — `{ scenario }` or `{ timeline, catalog? }` (≤ 15 events, ≤ 2 years): live replay in a Stripe test clock, returns `{ match, diffs, tera, stripe, test_clock }`; 429 with `retry-after` during the 30 s cooldown.
- The API is cookie-less and sends `Access-Control-Allow-Origin: *`, so browser apps on any origin can call it. Pages send a Content-Security-Policy, `nosniff`, Referrer-Policy and Permissions-Policy; `/robots.txt` keeps crawlers off `/api/`, `/sitemap.xml` and `/llms.txt` describe the site.

### FR8 MCP server [SHIPPED]
- `POST /api/mcp` is a Model Context Protocol server (Streamable HTTP, stateless) exposing tools `simulate_timeline`, `verify_timeline_in_stripe` (live replay in a Stripe test clock, same limits as `POST /api/parity`), `plan_price_migration`, `list_golden_scenarios`, `get_golden_scenario`.
- Tool input goes through the same validation as the REST API; rejected input returns a tool result with `isError: true` and the reason (never a protocol crash).
- `/mcp-setup` shows connection snippets (Claude Code, Cursor) and lists the live tools fetched from this deployment.

### FR9 Interactive API reference [SHIPPED]
- `/reference` renders the OpenAPI document with Scalar, including a "try it" client for every endpoint.

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

Golden values are **never** produced by Tera's own engine. They are derived by hand from the rules above and frozen only after Stripe parity confirms them (`status: "verified"`). As of 2026-10-17, **all 26 timeline scenarios are verified** (including amount_due, starting_balance and graduated metered tiers); S11 was corrected because Stripe disagreed with the hand derivation.

## 9. Out of scope (v1)
Real payments, dunning, multiple subscriptions per customer, mid-period tax changes, invoice PDFs.

## 10. Success criteria (hackathon)
- All golden scenarios are `verified` against Stripe.
- 20+ feature PRs, each gated by TestSprite with merge blocking enabled.
- At least 3 PRs where TestSprite caught a real billing bug, followed by a fix commit and a green check.
