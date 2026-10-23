#!/usr/bin/env node
// Runs the hand-written TestSprite API tests (testsprite/api/*.py) against one deployment: a PR's Vercel preview or
// production. TestSprite passes backend tests no target URL (`test run --target-url` is for frontend tests), so each
// file's default BASE_URL is rewritten to the target, stored with `test code put`, run, and put back to production.
// Exits 1 if a test fails. With too few credits it runs nothing and says so in the job summary (exit 0): a credit
// shortfall is not a test verdict, and docs/LOOP.md records those runs the same way.
// Usage: node scripts/testsprite-api-run.mjs <base-url>     (TESTSPRITE_API_KEY in the environment)
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROD = "https://tera-orpin-three.vercel.app";
const PER_TEST = 0.2; // TestSprite backend run price
// File -> cloud test in the "Tera API" project (065f775a-…).
const TESTS = {
  "golden_contract.py": "bfdc40f6-c768-4902-aefd-1c0a4c6c8967",
  "credit_balance.py": "04d59f1f-2f2d-4141-9e93-ed5fd5f92387",
  "rejections.py": "c7ac463c-21f9-4979-85e7-0eda50cfab4c",
  "parity_evidence.py": "e279d4e3-86a7-4335-ab6a-09e8744e1b97",
  "platform.py": "3a506d0b-dad6-48c4-9db7-5c1f17567caf",
};
const DEFAULT = /BASE_URL = os\.environ\.get\("TERA_BASE_URL", "https:\/\/tera-orpin-three\.vercel\.app"\)/;

const target = (process.argv[2] ?? PROD).replace(/\/$/, "");
const cli = (...args) => execFileSync("testsprite", [...args, "--output", "json"], { encoding: "utf8", maxBuffer: 32 << 20 });
const summary = (md) => (process.env.GITHUB_STEP_SUMMARY ? appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n") : console.log(md));
const tmp = mkdtempSync(join(tmpdir(), "tera-api-"));

const store = (file, url) => {
  const src = readFileSync(`testsprite/api/${file}`, "utf8");
  if (!DEFAULT.test(src)) throw new Error(`${file}: BASE_URL default line not found`);
  const path = join(tmp, file);
  writeFileSync(path, src.replace(DEFAULT, `BASE_URL = os.environ.get("TERA_BASE_URL", ${JSON.stringify(url)})`));
  cli("test", "code", "put", TESTS[file], "--code-file", path, "--force");
};

const files = Object.keys(TESTS);
const need = files.length * PER_TEST;
const credits = JSON.parse(cli("credits")).credits;
summary(`### TestSprite API tests against ${target}\n`);
if (credits < need) {
  summary(`**Not run:** ${files.length} tests need ${need.toFixed(1)} credits, ${credits} available. Nothing was tested; this is not a verdict.`);
  console.log(`::warning::TestSprite API tests not run: ${need.toFixed(1)} credits needed, ${credits} available`);
  process.exit(0);
}

const rows = [];
let failed = 0;
try {
  for (const file of files) {
    store(file, target);
    let verdict;
    // Exit 11 = rate limited: a PR's UI suite can hold TestSprite's 50 in-flight runs per user, so wait for room
    // (up to 30 minutes) instead of reporting a failure that tested nothing.
    for (let attempt = 0; ; attempt++) {
      try {
        const out = JSON.parse(cli("test", "run", TESTS[file], "--no-auto-heal", "--wait", "--timeout", "300"));
        verdict = out.status ?? out.result ?? "passed";
      } catch (e) {
        if (e.status === 11 && attempt < 30) {
          console.log(`${file}: TestSprite's in-flight run limit is reached; retrying in 60s`);
          execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
          continue;
        }
        // Exit 1 = failed/blocked; the JSON verdict is still on stdout.
        verdict = (() => { try { return JSON.parse(e.stdout).status ?? "failed"; } catch { return "failed"; } })();
        failed++;
      }
      break;
    }
    rows.push(`| \`${file}\` | ${TESTS[file].slice(0, 8)} | ${verdict} |`);
  }
} finally {
  // The stored code is what nightly and `test run` replay: leave it pointing at production.
  if (target !== PROD) for (const file of files) store(file, PROD);
}
summary(`| File | Cloud test | Verdict |\n|---|---|---|\n${rows.join("\n")}\n\n${files.length - failed}/${files.length} passed.`);
process.exit(failed ? 1 : 0);
