#!/usr/bin/env node
// When the TestSprite check fails on a pull request, asks Stripe's ground truth for a second opinion and comments on the PR.
// For every UI test that failed against the PR's preview, it downloads TestSprite's failure bundle (failed step, root-cause
// hypothesis), finds the golden scenarios the test exercises, and runs them through the billing engine on that same preview.
// The hand-derived invoices of those scenarios were replayed in real Stripe test clocks (golden/parity), so:
//   engine still matches Stripe -> the regression is in the UI;   engine differs -> the billing engine regressed.
//   TESTSPRITE_API_KEY=... GH_TOKEN=... node scripts/testsprite-triage.mjs <pr-number> <preview-url> [--dry-run] [--run <run-id>...]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import golden from "../golden/scenarios.json" with { type: "json" };
import evidence from "../golden/parity/index.json" with { type: "json" };

const PROJECT = "279e68e6-64c8-4c60-956e-6432e9e40f00";
const MARKER = "<!-- testsprite-triage -->";
const [pr, preview] = process.argv.slice(2);
const dryRun = process.argv.includes("--dry-run");
const onlyRuns = process.argv.flatMap((a, i, all) => (all[i - 1] === "--run" ? [a] : []));
const [cmd, ...pre] = process.env.TESTSPRITE_CLI ? ["node", process.env.TESTSPRITE_CLI] : ["npx", "-y", "@testsprite/testsprite-cli@0.15.0"];
const cli = (...args) =>
  JSON.parse(execFileSync(cmd, [...pre, "--output", "json", ...args], { encoding: "utf8", shell: cmd === "npx" && process.platform === "win32", env: { ...process.env, TESTSPRITE_NO_SKILL_WARNING: "1" } }));
const usd = (cents) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

// Golden scenarios a plan exercises: the ids it names, S05 when it opens the simulator without picking one, and the
// migration goldens (S24 plain, S25 grandfathered) for the migration planner's default customer base.
const plans = readdirSync("testsprite/plans").map((f) => JSON.parse(readFileSync(`testsprite/plans/${f}`, "utf8")));
function scenariosOf(testName) {
  const plan = plans.find((p) => p.name === testName);
  const text = plan ? plan.planSteps.map((s) => s.description).join(" ") : "";
  const ids = new Set(text.match(/\bS\d{2,4}\b/g) ?? []);
  if (!ids.size && /Simulator/.test(text)) ids.add("S05");
  if (/Migration/.test(text)) ["S24", "S25"].forEach((id) => ids.add(id));
  return [...ids].filter((id) => golden.scenarios.some((s) => s.id === id));
}

// Runs a golden scenario through the engine on the preview and diffs it against its hand-derived, Stripe-verified result.
async function check(id) {
  const s = golden.scenarios.find((x) => x.id === id);
  const post = (path, body) => fetch(`${preview}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  if (s.migration) {
    const m = s.migration;
    const r = await post("/api/migrate", { unit_amount: golden.catalog.prices[m.price].unit_amount, new_unit_amount: m.new_unit_amount, grandfather: m.grandfather, customers: m.customers });
    const diffs = Object.entries(s.expect_report).filter(([k, v]) => typeof v === "number" && r[k] !== v).map(([k, v]) => `${k} ${r[k]} ≠ ${v}`);
    return { id, title: s.title, diffs, proof: "hand-derived" };
  }
  const r = await post("/api/simulate", { timeline: s.timeline });
  const got = r.invoices ?? [];
  const diffs = r.error ? [r.error] : got.length !== s.expect.length ? [`${got.length} invoices ≠ ${s.expect.length}`] : [];
  s.expect.forEach((e, i) => got[i] && got[i].total !== e.total && diffs.push(`invoice ${i + 1} (${e.date}) ${usd(got[i].total)} ≠ ${usd(e.total)}`));
  const clock = evidence.find((x) => x.id === id && x.match)?.test_clock;
  return { id, title: s.title, diffs, proof: clock ? `Stripe test clock \`${clock}\`` : "hand-derived" };
}

// The failed runs of this preview: the latest failed run per test whose target is the preview (or the given run ids).
const tests = cli("test", "list", "--project", PROJECT, "--page-size", "100").items;
const failed = [];
for (const t of tests) {
  const runs = cli("test", "result", t.id, "--history", "--page-size", "50", ...(onlyRuns.length ? [] : ["--source", "github_action", "--since", "7d"])).runs ?? [];
  const run = onlyRuns.length ? runs.find((r) => onlyRuns.includes(r.runId)) : runs.find((r) => r.targetUrl?.startsWith(preview));
  if (run?.status === "failed") failed.push({ test: t, run });
}
if (!failed.length) {
  console.log(`No failed TestSprite run against ${preview}: nothing to triage (a check that failed before running, e.g. on credits, has no runs).`);
  process.exit(0);
}

const sections = [];
for (const { test, run } of failed) {
  const out = join(tmpdir(), `ts-${run.runId}`);
  cli("test", "artifact", "get", run.runId, "--out", out);
  const read = (f) => { try { return JSON.parse(readFileSync(join(out, f), "utf8")); } catch { return null; } };
  const meta = read("meta.json") ?? {};
  const failure = read("failure.json") ?? {};
  const step = read(`steps/${String(meta.failedStepIndex).padStart(2, "0")}-evidence.json`)?.[0]?.summary ?? `step ${meta.failedStepIndex}`;
  const checks = await Promise.all(scenariosOf(test.name).map(check));
  const verdict = !checks.length
    ? "No golden scenario behind this test, so there is no Stripe ground truth to compare."
    : checks.every((c) => !c.diffs.length)
      ? `**The billing engine on this preview still matches Stripe** for ${checks.map((c) => c.id).join(", ")}, so the regression is in the UI.`
      : "**The billing engine regressed:** it no longer produces the Stripe-verified invoices.";
  sections.push(
    [
      `### ❌ ${test.name}`,
      `TestSprite run \`${run.runId}\` · ${meta.failureKind ?? "failed"} · ${step.split("\n")[0].slice(0, 300)}`,
      "",
      verdict,
      ...checks.map((c) => `- ${c.diffs.length ? "❌" : "✅"} **${c.id}** ${c.title} (${c.proof})${c.diffs.length ? `: ${c.diffs.join("; ")}` : ""}`),
      ...(failure.rootCauseHypothesis ? ["", `<details><summary>TestSprite's root-cause hypothesis</summary>\n\n${failure.rootCauseHypothesis.slice(0, 1500)}\n</details>`] : []),
      "",
      `Reproduce: \`testsprite test artifact get ${run.runId}\` · \`testsprite test run ${test.id}\`${checks.length ? ` · \`curl ${preview}/api/scenarios/${checks[0].id}\`` : ""}`,
    ].join("\n"),
  );
}
const body = [MARKER, `## TestSprite triage: ${failed.length} failed test(s), checked against Stripe's ground truth`, "", ...sections].join("\n\n");
if (dryRun) {
  console.log(body);
  process.exit(0);
}
// One comment per PR, updated on every failed check.
const repo = process.env.GITHUB_REPOSITORY ?? "PugarHuda/tera";
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", input: a.includes("--input") ? JSON.stringify({ body }) : undefined });
const existing = JSON.parse(gh("api", `repos/${repo}/issues/${pr}/comments`, "--paginate")).find((c) => c.body.startsWith(MARKER));
if (existing) gh("api", "-X", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "--input", "-");
else gh("api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-");
console.log(`Triage comment ${existing ? "updated" : "posted"} on #${pr}`);
