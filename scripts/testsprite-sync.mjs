#!/usr/bin/env node
// Checks that testsprite/plans/*.json and the TestSprite UI project are the same suite: every plan file is a cloud test
// with the same steps, and every cloud test has a plan file. Exits 1 on any difference.
//   TESTSPRITE_API_KEY=... node scripts/testsprite-sync.mjs [path to the testsprite CLI]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const PROJECT = "279e68e6-64c8-4c60-956e-6432e9e40f00";
const [cmd, ...pre] = process.argv[2] ? ["node", process.argv[2]] : ["npx", "-y", "@testsprite/testsprite-cli@0.15.0"];
const cli = (...args) =>
  JSON.parse(execFileSync(cmd, [...pre, "--output", "json", ...args], { encoding: "utf8", shell: cmd === "npx" && process.platform === "win32", env: { ...process.env, TESTSPRITE_NO_SKILL_WARNING: "1" } }));

const cloud = cli("test", "list", "--project", PROJECT, "--page-size", "100").items;
const byName = new Map(cloud.map((t) => [t.name, t]));
const problems = [];
const seen = new Set();
for (const file of readdirSync("testsprite/plans").filter((f) => f.endsWith(".json"))) {
  const plan = JSON.parse(readFileSync(`testsprite/plans/${file}`, "utf8"));
  const test = byName.get(plan.name);
  if (!test) {
    problems.push(`${file}: no cloud test named "${plan.name}" (create it: testsprite test create --plan-from testsprite/plans/${file})`);
    continue;
  }
  seen.add(test.id);
  const steps = cli("test", "get", test.id).planSteps.map((s) => `${s.type}: ${s.description}`);
  const want = plan.planSteps.map((s) => `${s.type}: ${s.description}`);
  const i = want.findIndex((s, n) => s !== steps[n]);
  if (i !== -1 || want.length !== steps.length)
    problems.push(`${file}: cloud steps differ from step ${i === -1 ? want.length + 1 : i + 1} (push them: testsprite test plan put ${test.id} --steps <{ planSteps }>)`);
}
for (const t of cloud) if (!seen.has(t.id)) problems.push(`cloud test ${t.id} "${t.name}" has no plan file in testsprite/plans/`);

console.log(`${cloud.length} cloud tests, ${seen.size} matched to plan files, ${problems.length} problem(s)`);
for (const p of problems) console.log(`  ${p}`);
process.exitCode = problems.length ? 1 : 0;
