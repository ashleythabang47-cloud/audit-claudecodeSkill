---
name: audit
description: Use when the user asks to audit, document, or analyze a Node/Express(+TypeScript) backend, React frontend, and/or Python project — generates an API reference, architecture overview, key-flow diagrams, and a risk/test-coverage report, and for Python actually runs pytest for a real pass rate. Trigger on "/audit", "audit this repo", "document this codebase", "analyze this project's architecture", "what's our test pass rate".
---

# /audit — Codebase Health & Docs

Runs a dependency-free Node script against a repo (or a plain local folder —
no git required) and produces markdown reports summarizing its API surface,
architecture, key workflows, risk findings, and — for any detected Python
project — an actual pytest run with a real pass/fail percentage plus a
security pattern scan.

## When to use this

The user wants to understand or document a repo's structure, generate an API
reference, see its architecture as a diagram, get a quick risk/coverage pass
before a review or hand-off, or get a real test pass rate for a Python
component. Two independent analysis paths, both run automatically in one
pass:

- **Node/Express(+TS) + React**: deep analysis, tuned for a conventional
  `routes/` → `controllers/` → `models/` (+ optional `services/`,
  `middleware/`) layout. React frontends are detected and listed, but only
  the backend gets the deep route/risk analysis.
- **Python**: detected via `requirements.txt`, `pyproject.toml`, `Pipfile`,
  `setup.py`, or (failing those) any `.py` files at all. Runs `pytest` if
  it's installed and test files exist (`test_*.py` / `*_test.py`) for a real
  pass/fail count — this is **the only part of the tool that executes code**,
  everything else is static analysis. Also does a regex-based security scan
  (hardcoded secrets, shell/command injection via `subprocess(shell=True)`
  or `os.system` string concatenation, `eval`/`exec`, unsafe `pickle`/`yaml`
  deserialization, disabled TLS verification) and flags bare `except:` /
  reliance on `assert` for validation.

## How to run it

```bash
node scripts/audit.js <repoRoot> [outputDir]
```

- `repoRoot` — path to the project (repo or plain folder; monorepo-aware —
  it walks for every `package.json` / Python manifest under it).
- `outputDir` — defaults to `<repoRoot>/audit-output`.
- Running Python tests executes the project's actual test code. That's
  normal and expected for a test run, but mention it before running against
  a codebase that isn't the user's own if there's any doubt they're
  authorized to run it (e.g. a work codebase they were just handed to review
  or fix — being assigned to work on it is enough, being asked to glance at
  it is not).

Steps to take:

1. Confirm the repo path (ask if ambiguous — don't guess at a path the user
   didn't give you).
2. Run the script.
3. Read the generated `RISK_REPORT.md` and the console summary counts, and
   **spot-check 2-3 findings against the actual source** before reporting
   them as fact — the detector is regex/convention-based, not a real parser,
   and false positives happen (see Known limitations below). Don't just
   relay the raw finding list uncritically.
4. Summarize what changed/what's notable for the user in chat. Only hand over
   the actual files if they want them as files — per the user's standing
   preference, default to summarizing in chat rather than creating
   documents, unless they're explicitly building docs to keep/commit.
5. If they want the docs committed to the repo, that's a normal file write —
   just confirm where (e.g. `/docs/audit/`) before writing into their repo.

## What it checks

| File | Content |
|---|---|
| `API_REFERENCE.md` | Every route: method, path, full middleware chain (including file-level `router.use(...)`), resolved controller + file |
| `ARCHITECTURE.md` | Detected stacks, layer file counts, a mermaid `flowchart` of the request path |
| `FLOWS.md` | Mermaid sequence diagrams, grouped by first path segment, for route groups with 2+ endpoints |
| `RISK_REPORT.md` | missing-auth-middleware, missing-input-validation, sql-string-concatenation, missing-test-coverage — each with severity |
| `PYTHON_REPORT_<name>.md` (one per detected Python project) | Real pytest pass rate + failed test list (if pytest ran), plus security/quality findings: hardcoded-secret, shell-injection-risk, os-system-concatenation, eval-or-exec, unsafe-deserialization, unsafe-yaml-load, tls-verification-disabled, assert-for-control-flow, bare-except |

## Known limitations (tell the user these, don't hide them)

- **Validation detection is name-based.** It only recognizes validation done
  through a named helper (anything matching `/inputValidation\|validate\|sanitize/i`
  in the function body). Inline checks like `typeof x !== "string"` won't be
  recognized — those will still show up as findings even though the code is
  actually validating. Always eyeball the flagged function before reporting
  it as a real gap.
- **Test coverage is evidence-based, not execution-based.** It checks for a
  test file whose name or imports reference the file in question. It cannot
  tell whether that test actually exercises the risky code path, and it
  can't see coverage that comes from an end-to-end/integration test with no
  textual link to the source file.
- **Route parsing assumes a fairly conventional Express style**
  (`router.get("/path", mw1, mw2, controllerFn)` and `router.use(mw1, mw2)`
  for file-level middleware). Non-standard route registration (dynamically
  built routers, route arrays, decorators/NestJS-style controllers) won't be
  picked up — say so if a repo's route count looks suspiciously low compared
  to its route files.
- **No React/frontend route or component analysis yet** — frontend stacks
  are only listed as detected, not audited. If the user wants frontend
  coverage (component prop-drilling, unused exports, etc.), that's a real
  gap, not a silent miss — mention it rather than fabricating findings for
  the frontend.
- **SQL check is a narrow regex** (`SELECT/INSERT/UPDATE/DELETE` concatenated
  with `+`) — it will miss more creative injection patterns and may
  false-positive on string-building that never reaches a query call. Verify
  before calling it a real vulnerability.
- **Python findings are regex pattern matches, not real parsing** — same
  caveat as the SQL check. `assert`/bare-`except` findings in particular are
  style/robustness concerns, not confirmed bugs; don't report them as
  security issues.
- **The Python pass rate only reflects what `pytest` can discover and run
  as-is.** If the project needs environment setup (a `.env`, a running
  database, installed dependencies) that isn't in place, tests will error
  out rather than meaningfully fail, and the pass rate will understate the
  code's real correctness. Check the raw pytest output (and whether the
  project's dependencies are installed) before treating a low pass rate as
  proof the code is broken.
- **A pass rate only means what the test suite actually checks.** A high
  pass rate on a thin or stale test suite doesn't mean the code is correct,
  and a "success rate" metric a team is using (e.g. a deployment or grading
  success rate) may not be the same thing as test pass rate at all — confirm
  what the number is supposed to represent before equating them.

## Extending it

The script is one file (`scripts/audit.js`), organized as: JS/TS stack
discovery → backend analysis (route/controller/model mapping) → JS/TS risk
scanning → Python discovery/pytest/risk scanning → doc generation.

- To add a new JS/TS risk check, add a block to `scanRisks()` that pushes
  `{ severity, type, location, detail }` — it appears in `RISK_REPORT.md`.
- To add a new Python risk check, add an entry to the `PY_RISK_PATTERNS`
  array (a regex + severity + detail string) — it appears in each
  `PYTHON_REPORT_*.md` automatically, no other code changes needed.
