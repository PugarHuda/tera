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

TestSprite's generated code for a run can end with a single `assert current_url` (the outcome was judged by its AI agent during that run), so a replay of it proves little. For the tests listed here the stored code is replaced with hand-written Playwright that asserts exact values on `data-testid`s:

```bash
testsprite test code put <test-id> --code-file testsprite/code/ui-cancel-now.py --expected-version <v>
```

| File | Cloud test |
|---|---|
| `code/ui-cancel-now.py` | `03eeaac1-01b2-4af8-b622-de0d7f68cf3f` |
