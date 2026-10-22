#!/usr/bin/env node
// Checks that testsprite/plans/*.json, testsprite/code/*.py and the TestSprite UI project are the same suite: every plan file is a cloud test
// with the same steps and the same stored code, and every cloud test has a plan file. Exits 1 on any difference.
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
  // The stored code is what `test run` executes; an auto-healing run can rewrite it (pinning a preview URL, loosening
  // an assertion), so it must still be the hand-written file.
  const local = `testsprite/code/${file.replace(/\.json$/, ".py")}`;
  const norm = (s) => s.replace(/\r\n/g, "\n").trimEnd();
  let code;
  try {
    code = readFileSync(local, "utf8");
  } catch {
    problems.push(`${file}: no hand-written code at ${local}`);
    continue;
  }
  if (norm(cli("test", "code", "get", test.id).code) !== norm(code)) problems.push(`${local}: cloud code differs (push it: testsprite test code put ${test.id} --code-file ${local})`);
}
for (const t of cloud) if (!seen.has(t.id)) problems.push(`cloud test ${t.id} "${t.name}" has no plan file in testsprite/plans/`);

// Test lists and schedules (testsprite/suite.json). With --apply, missing ones are created and differing ones fixed.
const apply = process.argv.includes("--apply");
const suite = JSON.parse(readFileSync("testsprite/suite.json", "utf8"));
const planName = (file) => JSON.parse(readFileSync(`testsprite/plans/${file}.json`, "utf8")).name;
const lists = new Map(cli("testlist", "list").map((l) => [l.name, l]));
for (const [name, files] of Object.entries(suite.lists)) {
  let list = lists.get(name);
  if (!list && apply) list = cli("testlist", "create", "--name", name, "--project-env", `${PROJECT}:default`);
  if (!list) { problems.push(`test list "${name}" is missing (node scripts/testsprite-sync.mjs --apply)`); continue; }
  lists.set(name, list);
  const want = new Set(files.map((f) => byName.get(planName(f))?.id));
  const have = new Set(cli("testlist", "get", list.id).cases.map((c) => c.testId ?? c.id));
  const add = [...want].filter((id) => id && !have.has(id));
  const remove = [...have].filter((id) => !want.has(id));
  if (apply && add.length) cli("testlist", "add", list.id, ...add);
  if (apply && remove.length) cli("testlist", "remove", list.id, ...remove);
  if (!apply && (add.length || remove.length)) problems.push(`test list "${name}": ${add.length} test(s) to add, ${remove.length} to remove`);
}
const schedules = new Map(cli("schedule", "list").schedules.map((s) => [s.name, s]));
for (const s of suite.schedules) {
  const list = lists.get(s.list);
  const have = schedules.get(s.name);
  const flags = ["--cron", s.cron, "--timezone", s.timezone, ...(process.env.TESTSPRITE_NOTIFY ? ["--send-to", process.env.TESTSPRITE_NOTIFY] : [])];
  if (!have) {
    if (apply && list) cli("schedule", "create", "--name", s.name, "--target-type", "testList", "--target-id", list.id, ...flags);
    else problems.push(`schedule "${s.name}" is missing (node scripts/testsprite-sync.mjs --apply)`);
  } else if (have.cron !== s.cron || have.timezone !== s.timezone || have.targetId !== list?.id || !have.enabled) {
    if (apply) cli("schedule", "update", have.scheduleId, ...flags, ...(have.enabled ? [] : ["--resume"]));
    else problems.push(`schedule "${s.name}" differs from testsprite/suite.json (cron ${have.cron} ${have.timezone}${have.enabled ? "" : ", paused"})`);
  }
}

console.log(`${cloud.length} cloud tests, ${seen.size} matched to plan files, ${Object.keys(suite.lists).length} test list(s), ${suite.schedules.length} schedule(s), ${problems.length} problem(s)`);
for (const p of problems) console.log(`  ${p}`);
process.exitCode = problems.length ? 1 : 0;
