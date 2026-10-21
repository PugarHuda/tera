<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## TestSprite in this repo

- UI project `279e68e6-64c8-4c60-956e-6432e9e40f00` (plans in `testsprite/plans/`, hand-written code in `testsprite/code/`),
  API project `065f775a-db05-4c9e-a4f4-bfd6605e7fd7` (`testsprite/api/*.py`). The skills in `.claude/skills/testsprite-*`
  cover the CLI workflow.
- The repo is the source of truth. After editing a plan, push it with `testsprite test plan put <id> --steps <{ planSteps }>`;
  after editing `testsprite/code/_generate.py`, run it, check each file locally, then `testsprite test code put`.
  `node scripts/testsprite-sync.mjs` (in CI) fails when a plan and its cloud test differ.
- `testsprite test run <id>` executes the stored hand-written code; `testsprite test rerun <id>` replays the last agent
  recording instead. A UI run costs 0.5 credits, so the whole suite on a PR costs 14: check `testsprite credits` first.
