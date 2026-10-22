---
title: "I let Stripe grade my tests: building a billing simulator where no expected value comes from my own code"
published: true
tags: testing, stripe, testsprite, typescript
canonical_url: https://github.com/PugarHuda/tera/blob/main/docs/WRITEUP.md
---

*Built for the TestSprite Hackathon, Season 4. Live: [tera-orpin-three.vercel.app](https://tera-orpin-three.vercel.app) · Code: [github.com/PugarHuda/tera](https://github.com/PugarHuda/tera)*

Founders are afraid to touch pricing, and they are right to be. Move a customer from $29 to $79 on day 17 of a 31-day month and Stripe writes two proration lines you have probably never computed by hand: an "Unused time" credit of −$14.03 and a "Remaining time" charge of $38.23, on top of the $79 renewal. Add a coupon that was applied once, a tax rate that is inclusive, a trial, or a subscription in Stripe's new flexible billing mode, and the invoice your customer sees is no longer something you can predict from the pricing page.

Tera simulates it first. You give it a customer timeline (subscribe, change seats, upgrade, apply a coupon, pause, cancel) and it returns every invoice to the cent, plus the webhook events Stripe will send for it. This post is not really about the simulator, though. It is about the question every test suite eventually has to answer: **who decides what the right answer is?**

## The rule: the engine never writes its own expectations

The easiest way to get a green test suite for a billing engine is to run the engine, save its output, and assert that it does not change. That suite is worthless the day the engine is wrong, because it was wrong when the snapshot was taken too.

So Tera has one rule. Every expected value is derived by hand from the billing rules, written next to its arithmetic, and **then replayed in a real Stripe test-mode account with test clocks**. Scenario S05 in [`golden/scenarios.json`](https://github.com/PugarHuda/tera/blob/main/golden/scenarios.json) looks like this:

```json
"math": "remaining 15/31: -round(2900*15/31)=-1403, +round(7900*15/31)=3823",
"expect": [{ "date": "2027-02-01", "lines": [-1403, 3823, 7900], "total": 10320 }]
```

A script creates the same customer in Stripe, advances a test clock through the timeline, reads back Stripe's invoices and diffs them line by line against both the hand-derived values and Tera's engine. Only when all three agree is the scenario marked `verified`, and the evidence (invoice ids, test clock id) is committed to the repo. Today there are 130 golden scenarios and all 127 timelines among them match Stripe to the cent. The other three are migration scenarios with no invoices to replay.

When Stripe disagreed with my hand derivation, Stripe won, and I kept the receipts. A coupon applied in the same second as subscribing discounts the *next* invoice, because Stripe finalizes the first one at creation. A `repeating` coupon for 3 months lasts three calendar months, not three invoices. A percent discount on a proration comes off the rounded gross. None of those were in my head when I started.

## Letting Stripe find the cases I did not think of

Hand-written scenarios only cover what you already suspect. So Tera also runs **differential fuzzing**: a seeded generator produces random customer timelines, with month-end anchors, Feb 29, random times of day, trials, seat and plan changes, coupons and both tax behaviours. Each one runs through Tera and through Stripe, and any difference is a finding.

Every finding goes through the same pipeline: a targeted Stripe probe to isolate the rule, a new hand-derived golden scenario that pins it, then the engine fix. The fuzzer runs nightly in CI with fresh seeds, in both of Stripe's billing modes. The rules it surfaced are some of the most interesting in the repo. Stripe prorates the *unit* price to 12 decimals before multiplying by seats, so a credit of exactly 11257.5 lands a cent under the tie. In flexible mode every credit refunds its original debit with the gross and the discount rounded separately.

This week the same approach caught a real gap in usage-based billing. A code audit found the engine silently dropping metered usage on an immediate cancellation. Seven live probes gave the rules: tier lines run only up to the tier the usage reaches, a metered item has no unused-time line, and cancelling with `invoice_now` bills the usage so far. A follow-up fuzz batch for metered prices then found that Stripe still sends a $0 final invoice after an unused last period. It also found a stale usage window in my own replay script.

## Where TestSprite fits

Stripe is the oracle for the engine. TestSprite is the gate for everything a user actually touches.

- **28 UI tests on every pull request**, run by the TestSprite GitHub App against that PR's own Vercel preview. Branch protection requires the `TestSprite V3` check. Each test asserts hand-derived amounts in the browser: "Invoice 2 totals $103.20", not "an invoice is shown".
- **The tests live in the repo.** Every plan is a JSON file in `testsprite/plans/` and every test has hand-written Playwright code in `testsprite/code/`. A CI check compares both with the cloud project and fails on drift. That matters because an auto-healing run can quietly rewrite stored code, for example pinning a preview URL or loosening an assertion to two words.
- **API tests against the preview, too.** TestSprite gives backend tests no target URL, so a small script stores each API test with its base URL pointing at the PR's preview, runs it with auto-heal off, and puts production back.
- **Triage that uses the oracle.** When `TestSprite V3` fails, a workflow downloads the failure bundle, replays the golden scenarios behind that test on the same preview, and compares them with Stripe's recorded invoices. One PR comment then says either "engine still matches Stripe, so this is a UI regression" or which invoice the engine now gets wrong.
- **A nightly money-math canary** on production, plus Playwright user journeys, Schemathesis fuzzing of the OpenAPI spec, Arazzo workflows, Lighthouse budgets and Stryker mutation testing on every PR.

TestSprite caught a real bug before merge on PR #18. A price added in the builder billed $0.00 instead of ¥4,500, because the builder put a metered price first. The fix went in, and the check went green.

## What went wrong, honestly

The workspace ran out of TestSprite credits twice during the hackathon. When that happens the check reports "Not enough credits" without running a single test. Nine pull requests hit that wall; the ones that shipped were merged by the repository admin after every other check had passed. They are not hidden: [`docs/LOOP.md`](https://github.com/PugarHuda/tera/blob/main/docs/LOOP.md) is generated from the GitHub API and lists every PR and every commit's TestSprite verdict. Five went red on real test results, all fixed in the same PR, and nine were blocked by credits. A credit shortfall is not a test verdict, and treating it as one in either direction would make the ledger lie.

A second lesson: every new test layer I added found something about the *previous* layers. Schemathesis found the OpenAPI spec looser than the validator. Redocly Respect's strict schema checks found my conditional schemas rejecting properties their parent declared. Then my fix for that made Schemathesis unable to generate requests at all. Each layer is cheap. Not running the next one is what gets expensive.

## If you build something similar

1. Pick an oracle that is not your code. For billing it is Stripe's test clocks. For tax it could be a published calculator. For physics, a reference implementation.
2. Derive expectations by hand and write the arithmetic next to them. Future you will need it when the oracle disagrees.
3. Let the oracle generate the questions too (differential fuzzing), and turn every disagreement into a pinned example.
4. Keep your end-to-end tests in the repo and check the cloud copy against it.

Try it: open [the simulator on S05](https://tera-orpin-three.vercel.app/simulator?s=S05), change the upgrade date, and press **Verify in Stripe**. Your own timeline gets replayed in a fresh test clock and diffed to the cent.
