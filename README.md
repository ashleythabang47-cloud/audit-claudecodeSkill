## What this is

A custom Claude Code skill that audits a codebase and produces
documentation + a risk report in one pass. Built to speed up the
"understand an unfamiliar repo" step before a code review, hand-off,
or build-vs-fix decision.

## What it analyzes

**Node/Express(+TypeScript) + React:**
- Maps every route → middleware chain → controller → model
- Generates an API reference table and a mermaid architecture diagram
- Generates mermaid sequence diagrams for key workflows
- Flags: missing auth middleware, missing input validation, raw SQL
  string concatenation, controllers/services with no matching test

**Python:**
- Detects any Python project (requirements.txt, pyproject.toml,
  Pipfile, setup.py, or just loose .py files)
- Actually runs pytest and reports a real pass/fail rate — the only
  part of the tool that executes code rather than just reading it
- Scans for: hardcoded secrets, subprocess/os.system shell injection,
  eval/exec, unsafe pickle/yaml deserialization, disabled TLS
  verification, bare except, assert used for validation

## Known limitations

This is regex/convention-based static analysis, not a real parser —
every finding should be spot-checked against the actual code before
being treated as confirmed. Full limitations are documented in
SKILL.md.

## Usage

node scripts/audit.js <repoRoot> [outputDir]

Or, as a Claude Code skill: drop the `audit` folder into
~/.claude/skills/ and ask Claude Code to "audit this repo."
