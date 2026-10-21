# TestSprite suites as code

| Folder | Project | How it runs |
|---|---|---|
| `plans/*.json` | **Tera UI** (frontend) | The TestSprite GitHub App runs the UI suite against every PR's Vercel preview. Branch protection on `main` requires the `TestSprite V3` check. |
| `api/*.py` | **Tera API** (backend) | `.github/workflows/testsprite-api.yml` runs the API suite with the TestSprite CLI on every push to `main`, nightly, and on demand. |

Create or refresh a test from this folder:

```bash
testsprite test create --plan-from testsprite/plans/ui-credit-balance.json --run --wait
testsprite test create --project <api-project-id> --type backend --name "Golden contract" --code-file testsprite/api/golden_contract.py
```

Each `api/*.py` file reads `TERA_BASE_URL` (default: production), so the same file runs locally against a preview:

```bash
TERA_BASE_URL=https://tera-git-<branch>-hudas-projects-a8e7f558.vercel.app python testsprite/api/golden_contract.py
```

## Hand-written test code (`code/*.py`)

PR checks run TestSprite's agent against each plan, and its judge checks every plan assertion. The code a test stores
is different: the agent's generated code often ends with `assert current_url` (or a `select_option("")` that selects
nothing), so running it proves only that a page loaded. In October 2026, 18 of the 26 UI tests stored such code.
Every UI test now stores hand-written Playwright that asserts exact, hand-derived values on `data-testid`s and labels:

- `testsprite test run <id>` executes the stored code. Checked: with `$104.80` changed to `$999.99`, the cloud run
  failed with `Locator expected to have text '$999.99'`; restored, it passes.
- `testsprite test rerun <id>` does **not**: it replays the recording of the last agent run.

[`code/_generate.py`](code/_generate.py) writes most of the files (same browser setup as TestSprite's generated code,
one `# @@ts-step` per action and assertion) and prints the test id of each. Every file passes locally against
production before it is uploaded:

```bash
python testsprite/code/_generate.py
testsprite test code put <test-id> --code-file testsprite/code/<file> --expected-version <current codeVersion>
testsprite test run <test-id> --wait
```

| File | Cloud test |
|---|---|
| `code/ui-cancel-now.py` | `03eeaac1-01b2-4af8-b622-de0d7f68cf3f` |
| `code/ui-landing.py` | `581fbcef-2652-4f6b-9ee0-ca2e5bda540b` |
| `code/ui-webhooks.py` | `4e5d466b-356a-438f-8200-69a8c73d62d3` |
| `code/ui-reset-anchor.py` | `2cccee5c-d90b-4dc7-9d0c-2ac61e5ff3a7` |
| `code/ui-trial-change.py` | `7ba372bf-2683-48bc-95e8-b46d15901fd3` |
| `code/ui-credit-balance.py` | `01922f70-7d0b-40a3-8fa1-d4f0556652b6` |
| `code/ui-migrate-default.py` | `06eb515a-ae99-47d1-ae7f-ff17389beb56` |
| `code/ui-migrate-grandfather-toggle.py` | `b9ea281e-9480-4d89-854b-aa92342e462a` |
| `code/ui-migrate-invalid.py` | `813488e6-ced3-4f7f-af0e-759e84acbf01` |
| `code/ui-builder.py` | `048f474c-eb9a-4012-a50f-63dd022f95f3` |
| `code/ui-verify-stripe.py` | `c450f052-b403-4f96-bc47-25bb9122d5e2` |
| `code/ui-pause.py` | `57e74516-8f90-4358-afa4-1fed967215da` |
| `code/ui-trial-no-card.py` | `6ce9ff12-fec6-42a8-83aa-be38544b0191` |
| `code/ui-out-of-order.py` | `d78a6d51-e98b-4833-ab3b-3c47a7cd22e3` |
| `code/ui-out-of-order-events.py` | `ae61acdf-b2df-4d7a-b48b-57b8136a2f21` |
| `code/ui-golden-badge.py` | `7c474bd5-dc5a-4266-aea0-7e691aa4b314` |
| `code/ui-grandfather.py` | `76e782fd-5025-4ccb-9e41-88d705b67e8f` |
| `code/ui-grandfather-mrr.py` | `3c471e99-9cb1-41ca-a551-3ab25cca63b6` |
| `code/ui-edit-event.py` | `712061f7-6a13-46fd-b088-47b0ac1476ce` |
| `code/ui-migrate-invalid-input.py` | `571aec8c-a24d-496e-ae6f-8002ede422ba` |
| `code/ui-locale.py` | `4a8ea845-999a-4124-8bd6-1622198eb27f` |
| `code/ui-locale-de.py` | `09b27128-0c42-4a81-8042-b947933af9f0` |
| `code/ui-s05-totals.py` | `1fcef436-d9e7-4495-972c-f89ad5f41e80` |
