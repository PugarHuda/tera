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

Event types: `adjust_balance` (R23), `subscribe`, `start_trial` (optionally with `trial_end_behavior`, R22), `change_price`, `change_quantity`, `apply_coupon`, `report_usage`, `cancel_at_period_end`, `resume`, `end_trial`, `cancel_now`, `advance_to`.

## 4. Billing rules (the source of truth for the engine and the tests)

All rules mirror Stripe's documented behavior. Any rule marked **VERIFY** must be confirmed against Stripe test mode before its golden values are frozen.

### R1 — Money
- All amounts are integers in the currency's **minor unit** (USD cents, EUR cents). Zero-decimal currencies (JPY, KRW) use the major unit (¥3000 → `3000`).
- Each invoice line is rounded to an integer **independently**, then summed. Totals are never rounded again.
- Rounding mode: round half away from zero (an inclusive tax of exactly 64.5 is 65, S90; tax rounding is invoice level, R6). Stripe does not document its rounding mode; all 101 replayed timeline scenarios (prorations, percent coupons, inclusive/exclusive tax, graduated tiers with decimal unit amounts) match it to the cent.

### R2 — Billing periods
- The billing anchor is the subscription start. A monthly period runs from day *D* to day *D* of the next month (Jan 1 → Feb 1 = 31 days; Feb 1 → Mar 1 = 28 days, 29 in leap years).
- Time is measured in seconds. All golden scenarios use 00:00:00 UTC timestamps, so the fraction of a period equals the fraction of days.

### R3 — Proration (price or quantity change mid-period)
Two lines are generated, each rounded separately:
- **Unused time credit:** `−round(old_amount × remaining / period)`
- **Remaining time charge:** `+round(new_amount × remaining / period)`
- Stripe prorates the **unit** price first, to 12 decimal places, then multiplies by quantity and the paid rate, rounding once. So `7900 × 19/30 = 5003.333333333333`, and 3 seats at 75% credit `11257.4999… → 11257`, not the 11258 a fraction-exact `17775 × 19/30 = 11257.5` gives (S55, S56; found by fuzz seed 21001, confirmed by four Stripe probes). A real tie (`790 × 0.75 = 592.5`) still rounds away from zero.
- With a coupon (R5) the credit refunds the net amount paid in **one** rounding, `−round((paid amount) × f)`, while the charge is list minus discount rounded **separately**, `round(new × f) − round(discount × f)` (golden S42; the one-step version is a cent off).
- A change to the same quantity, or to the same price without a new quantity, is a no-op: no prorations (S38). With `always_invoice` it still invoices prorations pending from earlier changes at once (S43).
- A change made at the exact instant a period renews is invoiced separately from the renewal; with `always_invoice` that invoice is finalized first and its credit pays the renewal (S40).

where `old_amount`/`new_amount` = unit_amount × quantity.
- `proration_behavior = create_prorations` (default): lines are added to the **next** invoice.
- `proration_behavior = always_invoice`: lines are invoiced **immediately**.
- `proration_behavior = none`: see R14.
- Changing the **interval** (month → year) resets the billing anchor to the change time and invoices immediately: unused-time credit + full new-period charge.

### R4 — Trials
- A trial produces a $0 invoice at start. The first paid period starts when the trial ends and becomes the new billing anchor.
- Switching to a price with another interval during the trial issues another $0 trial invoice at once (S41).
- `end_trial` (Stripe `trial_end=now`) ends the trial early: the first paid period starts and is invoiced at that moment, which becomes the new anchor. A `once` coupon is not used up by the $0 trial invoice, so it discounts this one (S45).

### R5 — Coupons
- `percent_off` applies only to **non-proration** lines. Proration lines are priced already discounted and are not discounted again (Stripe marks them `discountable=false`; docs.stripe.com/billing/subscriptions/prorations). Golden S28.
- The **unused-time credit** refunds the rate the current amount was actually charged at: the period invoice's `percent_off` (even a `once` coupon that is now used up, S30), or the rate of the latest proration charge (S33). A coupon applied mid-period does not reduce the credit for time already paid in full (S34).
- The **remaining-time charge** is priced at the coupon still active at the change, and becomes what later credits refund.
- `amount_off` coupons count too: a period made free by `amount_off` refunds 0 when changed (S35), and a repeating `amount_off` is netted out of both proration lines (S36).
- A `once` coupon that prices a proration charge is used up by it, so the next invoice is not discounted (S37). A used-up coupon applied again starts afresh.
- Discounts apply even when prorations make the invoice negative (the remainder becomes credit, R10).
- `amount_off` is capped at the discountable (non-proration) subtotal.
- `amount_off` is capped at the subtotal; any remainder is lost (not carried over).
- `once` = first invoice only; `forever` = all invoices; `repeating` = *N* months of **calendar time** from when it is applied: every invoice before that end is discounted, the one at the end is not. On a monthly plan that is the first *N* invoices; after a yearly → monthly switch it is not (S50, found by fuzzing).
- A renewal invoice keeps the discount it was created with: a coupon applied at the exact renewal instant discounts the **next** invoice, and one removed at that instant still discounts the renewal (S57, found by fuzz seed 24019; removal confirmed by a Stripe probe). The renewal's credit later refunds what it actually charged.
- A coupon code applied to the same subscription more than once has **no additional effect** (idempotent, including page reloads and double submits).

### R6 — Tax
- Tax is computed **after** discounts.
- Exclusive: `tax = round(taxable × rate)`, `total = taxable + tax`.
- Inclusive: `total = taxable`, and the tax follows Stripe's **invoice-level tax rounding** ([Stripe docs](https://docs.stripe.com/billing/taxes/tax-rates#rounding); a Dashboard setting, this account's): each line's taxable amount `(amount − its share of the discount) / (1 + rate)` is kept to 12 decimals, rounded down; those are summed, the rate is applied to the sum, and the result is rounded once, half away from zero. In both billing modes.
  - The 12-decimal floor decides near-ties: 1019 + 7900 → 849.1666… + 6583.3333… = 7432.4999…, tax 1486, where round(8919 / 6) = 1487 (fuzz seeds 70012, 72005, 75012); 387 = −322.5 + 645 is a true tie, 64.5 → 65 (S90); −32258 + 51613 + 64000 JPY → 69462.4999…, 13892 (S93).
  - Found after a run of one-cent fuzz diffs that no per-line, per-sign or half-even rule explained; replaying the 29 timelines where the rules disagreed, this one matches Stripe on 28. Open: seed 40084, a coupon-priced credit, is a cent under Stripe, which fits a taxable amount taken from the credit's unrounded gross and discount instead of its rounded amount.
- A negative (credit) invoice carries negative tax (S39).

### R7 — Metered, graduated tiers
- Each tier charges its own units at its own rate: `Σ units_in_tier × tier_rate`, rounded once per line.

### R8 — Cancellation
- `cancel_at_period_end`: no renewal; the status becomes `canceled` at period end. Prorations still pending (and metered usage) are billed on a **final invoice** at that moment instead of being dropped (S39).
- `resume` (Stripe `cancel_at_period_end=false`) undoes a scheduled cancellation; renewals continue (S47).
- `remove_coupon` and `reset_anchor`: see R15.
- `cancel_now` cancels immediately with Stripe's defaults (`invoice_now=false`, `prorate=false`): no final invoice, no unused-time credit, and prorations still pending are never invoiced. A later `subscribe` starts a clean subscription (S46).

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
- Each subscription has a `billing_mode` (set on `subscribe` / `start_trial`, like Stripe). Tera's default is **classic**, which every rule above describes; **flexible**, Stripe's default for new subscriptions since API `2025-09-30.clover`, is R16. The parity replay sends the mode explicitly.
- Invoices created during an API call (subscription creation, `always_invoice`, interval change) are finalized immediately, so a coupon applied in the same instant affects the **next** invoice (golden S11, corrected after the Stripe replay contradicted the hand derivation).

### R13 — Changing the price of an item
- Like a Stripe subscription item update, `change_price` to a **different** price without a `quantity` resets the quantity to **1** (S31); pass `quantity` to keep seats (S32). The same price without a quantity keeps it (S38). Found by a live "Verify in Stripe" replay and by differential fuzzing.

### R14 — Changes without proration
- `proration_behavior = none` changes the price or quantity with no proration lines; the new amount bills from the next renewal (S44).
- A later prorated change credits the item **as it is then** (the unprorated new amount at the rate it was last charged), not what was actually paid for the period (S44, S49). Stripe does not remember the old amount.
- An interval change with `none` still resets the anchor and invoices the new interval at once, but without the unused-time credit (S48).

### R15 — Resetting the billing anchor
- `reset_anchor` (Stripe `billing_cycle_anchor: now`) starts a full new period at once, like an interval change: unused-time credit plus the full period, invoiced immediately; the change time becomes the anchor (S51).
- With `proration_behavior = none` there is no credit, but prorations pending from earlier changes are still swept into that invoice (S52).
- Not allowed during a trial (use `end_trial`).
- `remove_coupon` (Stripe `discounts: ""`) makes later invoices full price; the next unused-time credit still refunds what was actually paid, discount included (S53).
- A credit after an interval change refunds the discounted new-interval charge, `amount_off` included (S54: −26082, not −27014).

### R16 — Flexible billing mode
Derived by replaying all 54 classic goldens in Stripe with `billing_mode: flexible` (16 differed), then confirmed by hand-derived goldens S58–S66 and differential fuzzing in flexible mode.
- **Proration charges (both modes, R3/R5):** the gross comes from the 12-decimal prorated unit price, and a percent discount is taken off the *rounded* gross: 28542 × 25% = 7135.5 → 7136 gives 21406 (S79, found by fuzzing), 3135 × 25% = 783.75 → 784 gives 2351 (S42). A debit made free by a coupon is still credited, as a $0 line (S78).
- **Credits refund original debits.** Every span already debited (a period charge or a proration charge) is remembered with its unit price, quantity and discount. A change credits each debit still covering time after it, over that debit's own span, with gross and discount rounded **apart**, each from the 12-decimal prorated unit price: `round(unit·f·qty) − round(unit·f·qty·pct)` (S62: −4282 where one step gives −4281; S63: −11258 where classic gives −11257). After `proration_behavior = none` the old debit is what a later change credits, not the item as it is (S64, S65; the opposite of R14). A proration debit keeps its rounded gross and rounded discount, and a later credit rounds each again: 4/10 of 2806 − 702 is 1122 − 281 = 841, not round(2104 × 0.4) = 842 (S66, found by fuzzing). Only time up to the item's current period end is credited: after a `none` yearly → monthly change, a later change credits the yearly debit up to the monthly period end, not to its own end (S70, found by fuzzing).
- **The anchor never moves on its own.** An interval change keeps the anchor: the new interval's period is the one containing the change, aligned to the anchor (monthly → yearly on Jan 16 under a Jan 1 anchor debits Jan 1 → Jan 1 of the next year, S58). Nothing is invoiced at the change unless `always_invoice`; the prorations wait for the next renewal of the new interval.
- **Anchor reset nets out.** `reset_anchor` debits only the time past the old period end, as a proration on the next invoice (S61); `none` bills nothing, so that time is never debited (and never credited later, S62); `always_invoice` invoices it now.
- **No forced invoices.** A no-op change with `always_invoice` does not invoice pending items; a metered subscription gets no $0 invoice at creation (S59).
- **Trials.** Any price or quantity change during a trial issues its own $0 trial invoice at once (S60).

- **Flexible discounts and tax.** A proration charge takes its percent discount off the *unrounded* gross (S89: 841.94 × 25 % = 210.48 → 210, where classic takes 25 % of the rounded 842, 210.5 → 211, S79). Tax follows the invoice-level rule of R6 in this mode too (S93: 13892, where round(83355 / 6) = 13893; exclusive S94: round(757.7) = 758). All found by fuzzing.
- **A renewal claims a `once` coupon when it is drafted.** A change at the renewal instant is therefore priced without it, and the renewal keeps the discount (S95: the pro_y charge is the full 26544, the renewal 23700 − 4740). Mode-independent; found by fuzzing.

### R17 — Refund on immediate cancellation
- `cancel_now` with `proration_behavior = always_invoice` is Stripe's `cancel` with `prorate` and `invoice_now`: a final invoice is created at once with the prorations still pending and an unused-time credit, priced as any credit in the subscription's mode (classic: the item at the rate last charged; flexible: each original debit, R16). Tax applies to the credit (R6) and a negative total becomes credit balance (R10) that a later subscription consumes (S67, S68).
- `create_prorations` leaves the credit as a pending item on a canceled subscription: nothing is invoiced. Omitted or `none` is R8 (no final invoice). Cancelling a trial refunds nothing (nothing was paid).

### R18 — Minimum charge
- An amount due above zero but below Stripe's minimum charge (USD/EUR 0.50, GBP 0.30, JPY 50, … per docs.stripe.com/currencies) is not collected: the invoice's `amount_due` is 0 and the amount is carried as a **debit** customer balance, so the next invoice's `starting_balance` is positive and its amount due grows by it (S69: a 30-cent invoice, then 3600 + 30 = 3630). Found by fuzzing; applies in both billing modes. Stripe applies the minimum of the account's settlement currency after conversion; Tera uses the invoice currency's minimum, which is exact when they match (the reference account settles in USD).

### R19 — Cancel on a date
- `cancel_at` (Stripe `cancel_at`) ends the subscription on a given date, in both billing modes (probed in both).
- Inside the current period: on that date a final invoice carries the pending prorations and the credit for the time after it, priced as any credit in the mode (S71, S73); with `none` there is no credit and no invoice.
- In a later period: renewals continue, and the renewal whose period contains the date bills only up to it, as a proration priced like a remaining-time charge, gross and discount rounded apart (S72: 3950 − 988 = 2962); `none` does not change this. `resume` clears it. Not modelled during a trial (rejected).

### R20 — First billing date
- `subscribe` with `billing_cycle_anchor` (Stripe's anchor at creation) bills on a fixed day. The time from the start to the anchor is billed now as a proration priced like a remaining-time charge, divided by **one interval counted from the start** (S74: start 02-10, 02-10 → 03-10 is 28 days, 7900 × 23/28 = 6489; S77: start 05-31, one month is 05-31 → 06-30 = 30 days, found by fuzzing). A `once` coupon is used up by it (S75). With `proration_behavior = none` nothing is billed until the anchor. In flexible mode the stub instead divides by the **anchor-aligned period ending on the anchor** (S85: start 2028-03-05, anchor 03-22: 02-22 → 03-22 = 29 days, so round(6000 × 17/29) = 3517, not 6000 × 17/31; found by fuzzing three times, with leap-year and yearly cases), and it is a debit that a later change credits over its own days (S76).
- A flexible interval change before the first billing date aligns the new period to the anchor that is still ahead: start 06-01, anchor 06-24, a `none` switch to yearly on 06-09 sits in 2026-06-24 → 2027-06-24 and renews the yearly price on 06-24 (S102, fuzz seed 77004).
- The anchor must be after the start and at most one billing period ahead (Stripe rejects more). Not modelled for metered prices or trials.

### R21 — Pause and resume (Stripe API 2026-09-30.endive)
- `pause` (Stripe `POST /v1/subscriptions/:id/pause`) stops invoice generation at once: status `paused`, the current period ends now, and no renewal happens until `resume`. Flexible billing mode only, and not during a trial (Stripe rejects both; Tera does too). Coupons keep running in calendar time while paused.
- Unused time is credited from each original debit like any flexible credit, gross and discount rounded apart (S84: 3 seats with 25 % off, paused at 12:00 with 11.5 of 31 days left: −(8792 − 2198) = −6594). `proration_behavior` maps onto pause's billing options: default = `unused_time_from: now` + `invoicing_behavior: pending_invoice_item` (the credit waits for the next invoice, S80); `always_invoice` = `invoicing_behavior: invoice` (a credit invoice now that becomes customer balance, S82); `none` = `unused_time_from: none` (no credit, S83).
- `resume` of a paused subscription (Stripe `POST /v1/subscriptions/:id/resume`) with `billing_cycle_anchor: now` (default) starts a full new period now and invoices it at once together with anything pending (S80: −4077 + 7900 = 3823). With `billing_cycle_anchor: unchanged` the old anchor stays: nothing is invoiced at resume; the rest of the period that contains the resume date is charged as a pending proration billed at the next renewal (S81: 7900 × 14/28 = 3950, then −4077 + 3950 + 7900 = 7773). `none` skips that charge. That charge takes a percent discount off the **unrounded** gross (S88: 4209.68 × 25 % = 1052.42 → 1052, where a change's remaining-time charge would take 25 % of the rounded 4210, S79), and it is not made at all when the item was changed with `proration_behavior: none` in that same period (S86, probes Q1 and Q5); in a later period it is (S87).
- **Time already paid for is not charged again.** After a `none` pause (no credit) or a `none` change in the same period, the original debit still pays up to its period end. Resuming with an unchanged anchor inside that period charges nothing (S86, S92); resuming with `now` restarts the cycle but invoices nothing at once, and only the part of the new period after that coverage is a pending proration (S91: −, then round(7900 × 19/31) = 4842 on the next renewal; seeds 60131, 60134).
- Not modelled (rejected): pausing a metered price, pausing with a scheduled cancellation, other changes while paused, resuming with an unchanged anchor exactly on a billing date, and resuming with an unchanged **month-end** anchor (day 29–31). Open question for the last one: with the anchor on the 31st, Stripe charged 8 days of a 06-30 → 07-31 period as 6295 of 23700, which no period length explains (probe M1; the same timeline anchored on the 15th prorates normally, M2), so Tera rejects it instead of guessing.

### R22 — Trial without a card (Stripe `trial_settings.end_behavior.missing_payment_method`)
- `start_trial` with `trial_end_behavior` models a customer who has no card when the trial ends. `cancel`: the subscription is canceled at trial end and nothing is invoiced (S96). `pause`: it is paused at trial end, nothing is invoiced, and it stays paused until `resume` (probes T1, T2).
- Resuming it follows R21 with nothing paid for: flexible with `billing_cycle_anchor: now` invoices a full new period at once and moves the anchor (S98); `unchanged` (either mode) keeps the trial-end anchor and charges the rest of the period containing the resume date as a pending proration for the next renewal (S97: 2900 × 21/31 = 1965; S99, two cycles later: 2900 × 25/31 = 2339).
- That resume charge uses up a `once` coupon that prices it, like any remaining-time charge (S100: the renewal after it is not discounted; fuzz seeds 70016, 71010, 71023), even when an `amount_off` coupon makes it free: it is then a $0 debit, credited later as a $0 line (S101, fuzz seed 74022).
- Its tax follows R6: a ¥1766 resume charge next to 32000 carries 5628 (fuzz seed 74019), not the 294 + 5333 two per-line roundings give.
- Rejected: a classic resume with anchor `now` (Stripe voids the invoice it creates and the subscription stays paused, probe T2), `end_trial` with an end behavior (no card to pay), and changes while paused (Stripe: "You cannot set proration_behavior while a subscription is paused", probe T8). The parity replay creates the customer without a card and attaches `pm_card_visa` when it resumes.

### R23 — Customer balance adjustments
- `adjust_balance` with `amount` (minor units) is a Stripe customer balance transaction: negative is a credit, positive a debit. It changes the balance the next finalized invoice starts from (R10), so a credit lowers the amount due and carries over while it lasts, and a debit is added (S103: −1000 against a 2900 renewal leaves 1900 due; S104: +500 and −10000 net to −9500, which covers one 7900 invoice and 1600 of the next).

## 5. Invariants (must hold for every simulation)

- **I1** `total == Σ lines − discount + tax_exclusive`, and every amount is an integer.
- **I2** An unused-time credit never exceeds what was paid for that period (including earlier proration charges in the same period, S33).
- **I3** A `once` coupon discounts exactly one invoice, regardless of reloads or repeated applications.
- **I4** Zero-decimal currencies never display a decimal separator.
- **I5** Simulating the same timeline twice yields byte-identical invoices (deterministic).
- **I6** Invoice periods are contiguous with no gaps or overlaps, and `amount_due` is never negative (and is 0 or at least the minimum charge, R18).

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
- The page loads with golden scenario S05 selected. A "Load scenario" dropdown replaces the timeline with any golden scenario (S01–S104).
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
- `scripts/verify-golden.mts` replays every golden timeline in a Stripe **test-mode** account using test clocks (the billing mode each scenario sets, API `2026-09-30.endive`), fetches Stripe's invoices and diffs them line by line against Tera's engine (date, currency, line amounts, subtotal, discount, tax, total, starting_balance, amount_due). Matching scenarios are marked `"status": "verified"`; the evidence (Stripe invoice ids, test clock, customer) is committed under `golden/parity/`.
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
- Errors: malformed JSON, invalid fields or events out of date order → **400** `{ error }`; a body over 4 MB → **413**; unknown price/coupon/tax rate, an event before subscribe, or any R11 rejection → **422** `{ error }`. Dates run from 1970 to 2099.
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

Golden values are **never** produced by Tera's own engine. They are derived by hand from the rules above and frozen only after Stripe parity confirms them (`status: "verified"`). As of 2026-10-19, **all 101 timeline scenarios are verified** (both billing modes) (including amount_due, starting_balance and graduated metered tiers); S11 was corrected because Stripe disagreed with the hand derivation.

## 9. Out of scope (v1)
Real payments, dunning, multiple subscriptions per customer, mid-period tax changes, invoice PDFs.

## 10. Success criteria (hackathon)
- All golden scenarios are `verified` against Stripe.
- 20+ feature PRs, each gated by TestSprite with merge blocking enabled.
- At least 3 PRs where TestSprite caught a real billing bug, followed by a fix commit and a green check.
