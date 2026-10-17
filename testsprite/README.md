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
