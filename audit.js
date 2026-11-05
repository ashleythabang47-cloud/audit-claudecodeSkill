#!/usr/bin/env node
/**
 * /audit — Codebase Health & Docs scanner for Node/Express(+TS) + React repos.
 *
 * Usage:
 *   node audit.js <repoRoot> [outputDir]
 *
 * No npm dependencies — pure Node fs/path + regex heuristics, so it runs
 * against any repo without an install step. Produces:
 *   API_REFERENCE.md   — every route, its middleware chain, and its controller
 *   ARCHITECTURE.md    — layer overview + a mermaid component diagram
 *   FLOWS.md           — mermaid sequence diagrams for inferred key workflows
 *   RISK_REPORT.md     — missing auth / missing validation / raw SQL / missing tests
 *   audit-data.json    — the raw analysis, in case you want to script against it
 */

const fs = require("fs");
const path = require("path");

// ---------- small fs helpers ----------

function walk(dir, { ignore = [] } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, { ignore }));
    } else {
      out.push(full);
    }
  }
  return out;
}

const IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "venv",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  "site-packages",
  "env",
];

function readSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// ---------- stack discovery ----------

function findStackRoots(repoRoot) {
  // A "stack root" is any directory containing its own package.json
  // (handles monorepo-ish layouts like saics/backend, saics/frontend).
  const pkgFiles = walk(repoRoot, { ignore: IGNORE_DIRS }).filter((f) =>
    f.endsWith("package.json")
  );
  const roots = [];
  for (const pkgFile of pkgFiles) {
    const dir = path.dirname(pkgFile);
    let pkg = {};
    try {
      pkg = JSON.parse(readSafe(pkgFile));
    } catch {
      continue;
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const isBackend = !!(deps.express || deps.fastify || deps.koa);
    const isFrontend = !!(deps.react || deps.vue || deps.svelte);
    if (isBackend || isFrontend) {
      roots.push({
        dir,
        name: pkg.name || path.basename(dir),
        kind: isBackend ? "backend" : "frontend",
        deps,
      });
    }
  }
  return roots;
}

// A "python root" is any directory containing requirements.txt, pyproject.toml,
// Pipfile, or setup.py — or, failing that, the repoRoot itself if it has any
// .py files at all (covers a loose script collection with no manifest).
function findPythonRoots(repoRoot) {
  const manifestNames = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"];
  const allFiles = walk(repoRoot, { ignore: IGNORE_DIRS });
  const manifestFiles = allFiles.filter((f) => manifestNames.includes(path.basename(f)));

  const roots = [];
  const seenDirs = new Set();
  for (const mf of manifestFiles) {
    const dir = path.dirname(mf);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    roots.push({ dir, name: path.basename(dir), kind: "python" });
  }

  if (!roots.length) {
    const pyFiles = allFiles.filter((f) => f.endsWith(".py"));
    if (pyFiles.length) {
      roots.push({ dir: repoRoot, name: path.basename(repoRoot), kind: "python" });
    }
  }

  return roots;
}

// ---------- backend analysis: routes -> controllers -> models ----------

function findDir(root, candidates) {
  for (const c of candidates) {
    const p = path.join(root, "src", c);
    if (fs.existsSync(p)) return p;
    const p2 = path.join(root, c);
    if (fs.existsSync(p2)) return p2;
  }
  return null;
}

const ROUTE_LINE_RE =
  /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]\s*,([^;]*?)\);/gs;
const ROUTER_USE_RE = /router\.use\(\s*([^)]*?)\)/gs;

// Splits "a, b.single('x'), c" into ["a", "b.single('x')", "c"] without
// breaking on commas that are inside a nested call's parentheses.
function splitTopLevelArgs(blob) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of blob) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((s) => s.replace(/\n/g, " ").trim()).filter(Boolean);
}

function findRouterLevelMiddleware(content) {
  // router.use(requireAuth, requireAdmin) with no path argument (or a path
  // string followed by middleware) applies to every route below it in the file.
  const mw = [];
  let m;
  const re = new RegExp(ROUTER_USE_RE);
  while ((m = re.exec(content))) {
    const args = splitTopLevelArgs(m[1]).filter((a) => !/^["'`]/.test(a)); // drop path strings
    mw.push(...args);
  }
  return mw;
}

function parseRouteFile(file) {
  const content = readSafe(file);
  const routerLevelMw = findRouterLevelMiddleware(content);
  const routes = [];
  let m;
  const re = new RegExp(ROUTE_LINE_RE);
  while ((m = re.exec(content))) {
    const [, method, routePath, argsBlob] = m;
    const parts = splitTopLevelArgs(argsBlob);
    const controller = parts.length ? parts[parts.length - 1] : null;
    const routeLevelMw = parts.slice(0, -1);
    routes.push({
      method: method.toUpperCase(),
      path: routePath,
      middleware: [...routerLevelMw, ...routeLevelMw],
      controller,
      file: path.basename(file),
    });
  }
  return routes;
}

function extractImports(content) {
  // import { a, b } from '../models/x'   or   import x from '../models/x'
  const imports = [];
  const re = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(content))) {
    const names = m[1]
      ? m[1].split(",").map((s) => s.trim().split(" as ")[0].trim())
      : [m[2]];
    imports.push({ names, from: m[3] });
  }
  return imports;
}

function extractExportedFunctionNames(content) {
  const names = new Set();
  const patterns = [
    /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
    /export\s+async\s+function\s+(\w+)/g,
    /export\s+function\s+(\w+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content))) names.add(m[1]);
  }
  return names;
}

// Given the full file content and the index right after a function's
// opening "{", walk forward counting brace depth (skipping string/template
// literals and comments well enough for real-world TS) to find the matching
// close brace, and return the body substring.
function extractBodyFrom(content, openBraceIdx) {
  let depth = 0;
  let i = openBraceIdx;
  let inString = null; // one of ' " ` or null
  for (; i < content.length; i++) {
    const ch = content[i];
    const prev = content[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return content.slice(openBraceIdx, i + 1);
    }
  }
  return content.slice(openBraceIdx); // unbalanced — fall back to rest of file
}

// name -> individual function body (not the whole file), so later checks
// (req.body usage, validation calls, etc.) don't leak across functions
// that merely happen to share a file.
function extractFunctionBodies(content) {
  const bodies = {};
  const patterns = [
    /export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)[^{]*\{/g,
    /export\s+async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{/g,
    /export\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content))) {
      const name = m[1];
      const openBraceIdx = m.index + m[0].length - 1; // position of the "{"
      bodies[name] = extractBodyFrom(content, openBraceIdx);
    }
  }
  return bodies;
}

function analyzeBackend(stackRoot) {
  const srcRoot = fs.existsSync(path.join(stackRoot.dir, "src"))
    ? path.join(stackRoot.dir, "src")
    : stackRoot.dir;

  const routesDir = findDir(stackRoot.dir, ["routes"]);
  const controllersDir = findDir(stackRoot.dir, ["controllers"]);
  const modelsDir = findDir(stackRoot.dir, ["models"]);
  const middlewareDir = findDir(stackRoot.dir, ["middleware"]);
  const utilsDir = findDir(stackRoot.dir, ["utils"]);
  const servicesDir = findDir(stackRoot.dir, ["services"]);

  const routeFiles = routesDir
    ? walk(routesDir, { ignore: IGNORE_DIRS }).filter((f) => /\.(ts|js)$/.test(f))
    : [];
  const controllerFiles = controllersDir
    ? walk(controllersDir, { ignore: IGNORE_DIRS }).filter((f) => /\.(ts|js)$/.test(f))
    : [];
  const modelFiles = modelsDir
    ? walk(modelsDir, { ignore: IGNORE_DIRS }).filter((f) => /\.(ts|js)$/.test(f))
    : [];

  // index controller exports: name -> { file, fileContent, content (this
  // function's own body — NOT the whole file, so checks don't leak across
  // unrelated functions that happen to share a file) }
  const controllerIndex = {};
  for (const f of controllerFiles) {
    const fileContent = readSafe(f);
    const bodies = extractFunctionBodies(fileContent);
    for (const name of extractExportedFunctionNames(fileContent)) {
      controllerIndex[name] = { file: f, fileContent, content: bodies[name] || "" };
    }
  }

  // index model exports similarly
  const modelIndex = {};
  for (const f of modelFiles) {
    const fileContent = readSafe(f);
    const bodies = extractFunctionBodies(fileContent);
    for (const name of extractExportedFunctionNames(fileContent)) {
      modelIndex[name] = { file: f, fileContent, content: bodies[name] || "" };
    }
  }

  // all routes, with controller resolved to its file + model usage
  const allRoutes = [];
  for (const rf of routeFiles) {
    const routes = parseRouteFile(rf);
    const fileContent = readSafe(rf);
    const imports = extractImports(fileContent);

    for (const r of routes) {
      // controller may be "obj.method" or "fnName" or "namespace.fn"
      const bareName = r.controller ? r.controller.split(".").pop() : null;
      const resolved = bareName ? controllerIndex[bareName] : null;

      let modelsUsed = [];
      if (resolved) {
        const cImports = extractImports(resolved.fileContent);
        modelsUsed = cImports
          .filter((imp) => /models?\//.test(imp.from))
          .flatMap((imp) => imp.names);
      }

      allRoutes.push({
        ...r,
        routeFile: path.relative(stackRoot.dir, rf),
        controllerFile: resolved ? path.relative(stackRoot.dir, resolved.file) : null,
        controllerFound: !!resolved,
        modelsUsed,
      });
    }
  }

  return {
    stackName: stackRoot.name,
    dir: stackRoot.dir,
    dirs: {
      routes: routesDir && path.relative(stackRoot.dir, routesDir),
      controllers: controllersDir && path.relative(stackRoot.dir, controllersDir),
      models: modelsDir && path.relative(stackRoot.dir, modelsDir),
      middleware: middlewareDir && path.relative(stackRoot.dir, middlewareDir),
      services: servicesDir && path.relative(stackRoot.dir, servicesDir),
      utils: utilsDir && path.relative(stackRoot.dir, utilsDir),
    },
    routes: allRoutes,
    controllerFiles: controllerFiles.map((f) => path.relative(stackRoot.dir, f)),
    modelFiles: modelFiles.map((f) => path.relative(stackRoot.dir, f)),
    serviceFiles: servicesDir
      ? walk(servicesDir, { ignore: IGNORE_DIRS })
          .filter((f) => /\.(ts|js)$/.test(f))
          .map((f) => path.relative(stackRoot.dir, f))
      : [],
    controllerIndex,
    modelIndex,
  };
}

// ---------- risk scanning ----------

function findTestFiles(stackRoot) {
  const all = walk(stackRoot.dir, { ignore: IGNORE_DIRS });
  return all.filter((f) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f));
}

function baseNameNoExt(f) {
  return path.basename(f).replace(/\.(ts|tsx|js|jsx)$/, "");
}

function scanRisks(backend) {
  const findings = [];

  // 1. Missing auth middleware on non-public-looking routes
  const authish = /auth|verify|protect|requireAuth|isAuthenticated/i;
  const publicish = /login|register|verify-?email|health|public|forgot|reset/i;
  for (const r of backend.routes) {
    const hasAuthMw = r.middleware.some((m) => authish.test(m));
    const looksPublic = publicish.test(r.path);
    if (!hasAuthMw && !looksPublic) {
      findings.push({
        severity: "medium",
        type: "missing-auth-middleware",
        location: `${r.method} ${r.path} (${r.routeFile})`,
        detail:
          "No auth-looking middleware on this route and the path doesn't look public. Verify it's intentionally open.",
      });
    }
  }

  // 2. Controllers that never touch the input-validation utils
  if (backend.dirs.utils) {
    for (const [name, { file, content }] of Object.entries(backend.controllerIndex)) {
      const looksLikeWrite = /req\.body/.test(content);
      const usesValidation = /inputValidation|validate|sanitize/i.test(content);
      if (looksLikeWrite && !usesValidation) {
        findings.push({
          severity: "medium",
          type: "missing-input-validation",
          location: `${name} (${path.relative(backend.dir, file)})`,
          detail:
            "Reads req.body but doesn't appear to call any validation/sanitize helper.",
        });
      }
    }
  }

  // 3. Raw SQL built with string concatenation instead of placeholders
  for (const [name, { file, content }] of Object.entries(backend.modelIndex)) {
    const concatSqlRe = /(SELECT|INSERT|UPDATE|DELETE)[^`'";]*\+\s*\w+/i;
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (concatSqlRe.test(line) && !/\?/.test(line)) {
        findings.push({
          severity: "high",
          type: "sql-string-concatenation",
          location: `${name} (${path.relative(backend.dir, file)}:${i + 1})`,
          detail: "SQL built with string concatenation — possible injection risk. Use parameterized placeholders.",
        });
      }
    });
  }

  // 4. Controllers/services with no matching test file
  const testFiles = findTestFiles({ dir: backend.dir });
  // Prefer actual import evidence over filename guessing: a test named
  // "admin.integration.test.ts" still proves coverage of adminController.ts
  // if it imports from that path, which a filename-substring check misses.
  const testFileContents = testFiles.map((f) => readSafe(f));
  const testFileBaseNames = testFiles.map(baseNameNoExt);
  const testedSomewhere = (base, sourceFile) => {
    const baseLower = base.toLowerCase();
    if (testFileBaseNames.some((t) => t.toLowerCase().includes(baseLower))) return true;
    if (sourceFile) {
      return testFileContents.some((c) => c.includes(baseNameNoExt(sourceFile)));
    }
    return false;
  };

  for (const cf of backend.controllerFiles) {
    const base = baseNameNoExt(cf);
    if (!testedSomewhere(base, cf)) {
      findings.push({
        severity: "low",
        type: "missing-test-coverage",
        location: cf,
        detail: "No test file name matches this controller. Confirm it's covered indirectly, or add a test.",
      });
    }
  }
  for (const sf of backend.serviceFiles) {
    const base = baseNameNoExt(sf);
    if (!testedSomewhere(base, sf)) {
      findings.push({
        severity: "low",
        type: "missing-test-coverage",
        location: sf,
        detail: "No test file name matches this service. Confirm it's covered indirectly, or add a test.",
      });
    }
  }

  return findings;
}

// ---------- python analysis ----------

const { execSync } = require("child_process");

function findPythonFiles(pyRoot) {
  return walk(pyRoot.dir, { ignore: IGNORE_DIRS }).filter((f) => f.endsWith(".py"));
}

function findPythonTestFiles(pyRoot) {
  return findPythonFiles(pyRoot).filter((f) => {
    const base = path.basename(f);
    return base.startsWith("test_") || base.endsWith("_test.py");
  });
}

// Runs pytest if it's available and the project has test files, parses the
// standard summary line ("3 failed, 12 passed, 1 skipped in 2.10s"), and
// returns null (never throws) if pytest isn't installed or nothing runs —
// callers must treat null as "couldn't determine," not "0%."
function runPytest(pyRoot) {
  const testFiles = findPythonTestFiles(pyRoot);
  if (!testFiles.length) return { ran: false, reason: "no test_*.py or *_test.py files found" };

  let pytestAvailable = false;
  try {
    execSync("python3 -m pytest --version", { cwd: pyRoot.dir, stdio: "pipe" });
    pytestAvailable = true;
  } catch {
    try {
      execSync("pytest --version", { cwd: pyRoot.dir, stdio: "pipe" });
      pytestAvailable = true;
    } catch {
      pytestAvailable = false;
    }
  }
  if (!pytestAvailable) {
    return { ran: false, reason: "pytest is not installed in this environment" };
  }

  let output = "";
  try {
    output = execSync("python3 -m pytest -q --tb=no 2>&1 || true", {
      cwd: pyRoot.dir,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    // execSync throws on non-zero exit even with the || true above on some
    // shells; fall back to whatever output it captured.
    output = (e.stdout || "").toString() + (e.stderr || "").toString();
  }

  // pytest's short summary line, e.g.:
  //   "3 failed, 12 passed, 1 skipped in 2.10s"
  //   "5 passed in 0.80s"
  const summaryMatch = output.match(
    /(\d+)\s+passed|(\d+)\s+failed|(\d+)\s+error|(\d+)\s+skipped/g
  );
  if (!summaryMatch) {
    return { ran: true, parsed: false, rawTail: output.slice(-1500) };
  }

  const counts = { passed: 0, failed: 0, error: 0, skipped: 0 };
  for (const chunk of summaryMatch) {
    const [num, label] = chunk.trim().split(/\s+/);
    if (counts[label] !== undefined) counts[label] = parseInt(num, 10);
  }
  const total = counts.passed + counts.failed + counts.error + counts.skipped;
  const passRate = total > 0 ? Math.round((counts.passed / total) * 1000) / 10 : null;

  // pull individual FAILED lines for detail
  const failedLines = output
    .split("\n")
    .filter((l) => l.startsWith("FAILED "))
    .map((l) => l.replace(/^FAILED\s+/, "").trim());

  return { ran: true, parsed: true, counts, total, passRate, failedLines };
}

const PY_RISK_PATTERNS = [
  {
    type: "hardcoded-secret",
    severity: "high",
    re: /(API_KEY|SECRET|PASSWORD|TOKEN|ACCESS_KEY)\s*=\s*["'][^"'\s]{8,}["']/,
    detail: "Looks like a credential or secret hardcoded directly in source rather than loaded from the environment.",
  },
  {
    type: "shell-injection-risk",
    severity: "high",
    re: /subprocess\.(run|call|Popen|check_output|check_call)\([^)]*shell\s*=\s*True/,
    detail: "subprocess call with shell=True — if any part of the command includes user input, this is a shell injection risk.",
  },
  {
    type: "os-system-concatenation",
    severity: "high",
    re: /os\.system\([^)]*\+/,
    detail: "os.system() built with string concatenation — if any part is user input, this is a command injection risk.",
  },
  {
    type: "eval-or-exec",
    severity: "high",
    re: /\b(eval|exec)\(/,
    detail: "eval()/exec() on dynamic input can execute arbitrary code. Confirm the argument is never user-controlled.",
  },
  {
    type: "unsafe-deserialization",
    severity: "medium",
    re: /pickle\.(load|loads)\(/,
    detail: "pickle can execute arbitrary code when deserializing untrusted data. Avoid unpickling anything from outside the app.",
  },
  {
    type: "unsafe-yaml-load",
    severity: "medium",
    re: /yaml\.load\(([^)]*)\)/,
    detail: "yaml.load() without Loader=yaml.SafeLoader can execute arbitrary code from the YAML content.",
    extraCheck: (m) => !/SafeLoader/.test(m[0]),
  },
  {
    type: "tls-verification-disabled",
    severity: "high",
    re: /verify\s*=\s*False/,
    detail: "TLS certificate verification disabled — requests are vulnerable to interception.",
  },
  {
    type: "assert-for-control-flow",
    severity: "low",
    re: /^\s*assert\s+/,
    detail: "assert statements are stripped out when Python runs with -O (optimized mode) — don't rely on them for real validation/security checks.",
  },
  {
    type: "bare-except",
    severity: "low",
    re: /^\s*except\s*:\s*$/,
    detail: "Bare except: silently swallows every error including the ones you'd want to know about (KeyboardInterrupt, real bugs). Catch a specific exception.",
  },
];

function scanPythonRisks(pyRoot) {
  const findings = [];
  const files = findPythonFiles(pyRoot).filter((f) => !findPythonTestFiles(pyRoot).includes(f));

  for (const file of files) {
    const content = readSafe(file);
    const lines = content.split("\n");
    for (const pattern of PY_RISK_PATTERNS) {
      lines.forEach((line, i) => {
        const m = line.match(pattern.re);
        if (!m) return;
        if (pattern.extraCheck && !pattern.extraCheck(m)) return;
        findings.push({
          severity: pattern.severity,
          type: pattern.type,
          location: `${path.relative(pyRoot.dir, file)}:${i + 1}`,
          detail: pattern.detail,
        });
      });
    }
  }
  return findings;
}

function genPythonReport(pyRoot, pytestResult, findings) {
  let md = `# Python Analysis: ${pyRoot.name}\n\nAuto-generated. Regenerate with \`/audit\`.\n\n`;

  md += `## Test results\n\n`;
  if (!pytestResult.ran) {
    md += `Tests were not run: ${pytestResult.reason}.\n\n`;
  } else if (!pytestResult.parsed) {
    md += `pytest ran but the output couldn't be parsed into pass/fail counts. Raw tail:\n\n\`\`\`\n${pytestResult.rawTail}\n\`\`\`\n\n`;
  } else {
    const { counts, total, passRate } = pytestResult;
    md += `**${passRate}% pass rate** — ${counts.passed}/${total} passed`;
    if (counts.failed) md += `, ${counts.failed} failed`;
    if (counts.error) md += `, ${counts.error} errored`;
    if (counts.skipped) md += `, ${counts.skipped} skipped`;
    md += `.\n\n`;
    if (pytestResult.failedLines.length) {
      md += `**Failed tests:**\n\n`;
      for (const l of pytestResult.failedLines) md += `- \`${l}\`\n`;
      md += `\n`;
    }
  }

  const bySeverity = { high: [], medium: [], low: [] };
  for (const f of findings) bySeverity[f.severity].push(f);

  md += `## Security & quality findings\n\n`;
  md += `**Summary:** ${bySeverity.high.length} high, ${bySeverity.medium.length} medium, ${bySeverity.low.length} low.\n\n`;
  md += `> Regex-based pattern matching, not a real Python parser. Verify each finding against the actual code before treating it as confirmed — especially \`assert\`/bare-except, which are style concerns, not necessarily bugs.\n\n`;

  for (const sev of ["high", "medium", "low"]) {
    if (!bySeverity[sev].length) continue;
    md += `### ${sev[0].toUpperCase() + sev.slice(1)} severity\n\n`;
    for (const f of bySeverity[sev]) {
      md += `- **${f.type}** — \`${f.location}\`\n  ${f.detail}\n`;
    }
    md += `\n`;
  }

  return md;
}

// ---------- doc generation ----------

function genApiReference(backendAnalyses) {
  let md = `# API Reference\n\nAuto-generated from route definitions. Regenerate with \`/audit\` after changing routes.\n\n`;
  for (const b of backendAnalyses) {
    md += `## ${b.stackName}\n\n`;
    md += `| Method | Path | Middleware | Controller | File |\n`;
    md += `|---|---|---|---|---|\n`;
    for (const r of b.routes) {
      const mw = r.middleware.length ? r.middleware.join(", ") : "—";
      const ctrl = r.controller || "—";
      const ctrlFile = r.controllerFile || "*(not resolved)*";
      md += `| ${r.method} | \`${r.path}\` | ${mw} | ${ctrl} | ${ctrlFile} |\n`;
    }
    md += `\n`;
  }
  return md;
}

function genArchitecture(stackRoots, backendAnalyses) {
  let md = `# Architecture Overview\n\nAuto-generated layer map. Regenerate with \`/audit\`.\n\n`;

  md += `## Stacks detected\n\n`;
  for (const s of stackRoots) {
    md += `- **${s.name}** (${s.kind}) — \`${path.relative(process.cwd(), s.dir) || "."}\`\n`;
  }
  md += `\n`;

  for (const b of backendAnalyses) {
    md += `## ${b.stackName} layers\n\n`;
    md += `- Routes: \`${b.dirs.routes || "—"}\` (${b.routes.length} endpoints)\n`;
    md += `- Controllers: \`${b.dirs.controllers || "—"}\` (${b.controllerFiles.length} files)\n`;
    md += `- Models: \`${b.dirs.models || "—"}\` (${b.modelFiles.length} files)\n`;
    md += `- Services: \`${b.dirs.services || "—"}\` (${b.serviceFiles.length} files)\n`;
    md += `- Middleware: \`${b.dirs.middleware || "—"}\`\n\n`;

    md += "```mermaid\nflowchart LR\n";
    md += `  Client --> Routes["${b.dirs.routes || "routes"}"]\n`;
    md += `  Routes --> Middleware["${b.dirs.middleware || "middleware"}"]\n`;
    md += `  Middleware --> Controllers["${b.dirs.controllers || "controllers"}"]\n`;
    md += `  Controllers --> Services["${b.dirs.services || "services"}"]\n`;
    md += `  Controllers --> Models["${b.dirs.models || "models"}"]\n`;
    md += `  Models --> DB[(Database)]\n`;
    md += "```\n\n";
  }
  return md;
}

function genFlows(backendAnalyses) {
  let md = `# Key Flows\n\nInferred sequence diagrams for notable multi-layer workflows. Regenerate with \`/audit\`.\n\n`;

  for (const b of backendAnalyses) {
    // Group routes by the first path segment as a rough "feature" grouping
    const groups = {};
    for (const r of b.routes) {
      const seg = r.path.split("/").filter(Boolean)[0] || "root";
      groups[seg] = groups[seg] || [];
      groups[seg].push(r);
    }
    const interestingGroups = Object.entries(groups)
      .filter(([, routes]) => routes.length >= 2)
      .slice(0, 5);

    for (const [seg, routes] of interestingGroups) {
      md += `## ${b.stackName}: \`/${seg}\`\n\n`;
      md += "```mermaid\nsequenceDiagram\n  participant C as Client\n  participant R as Route\n  participant Ctrl as Controller\n  participant M as Model/DB\n";
      for (const r of routes) {
        const ctrl = r.controller || "handler";
        md += `  C->>R: ${r.method} ${r.path}\n`;
        md += `  R->>Ctrl: ${ctrl}()\n`;
        if (r.modelsUsed.length) {
          md += `  Ctrl->>M: ${r.modelsUsed.slice(0, 3).join(", ")}\n`;
          md += `  M-->>Ctrl: result\n`;
        }
        md += `  Ctrl-->>C: response\n`;
      }
      md += "```\n\n";
    }
  }
  return md;
}

function genRiskReport(allFindings) {
  const bySeverity = { high: [], medium: [], low: [] };
  for (const f of allFindings) bySeverity[f.severity].push(f);

  let md = `# Risk & Coverage Report\n\nAuto-generated. Regenerate with \`/audit\` after changes.\n\n`;
  md += `**Summary:** ${bySeverity.high.length} high, ${bySeverity.medium.length} medium, ${bySeverity.low.length} low.\n\n`;
  md += `> **Heuristics, not ground truth.** This is pattern-matching, not real understanding of the code. A "missing-input-validation" finding means no call to a *named* validation/sanitize helper was found in that function — inline checks (e.g. \`typeof x !== "string"\`) won't be recognized as validation and will still be flagged. "missing-test-coverage" means no test file name or import matched — it can miss tests that exercise the code indirectly (e.g. through an integration test of a different route). Treat every finding as "worth a human look," not as a confirmed bug.\n\n`;

  for (const sev of ["high", "medium", "low"]) {
    if (!bySeverity[sev].length) continue;
    md += `## ${sev[0].toUpperCase() + sev.slice(1)} severity\n\n`;
    for (const f of bySeverity[sev]) {
      md += `- **${f.type}** — \`${f.location}\`\n  ${f.detail}\n`;
    }
    md += `\n`;
  }
  return md;
}

// ---------- main ----------

function main() {
  const repoRoot = process.argv[2];
  const outDir = process.argv[3] || path.join(repoRoot, "audit-output");

  if (!repoRoot || !fs.existsSync(repoRoot)) {
    console.error("Usage: node audit.js <repoRoot> [outputDir]");
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const stackRoots = findStackRoots(repoRoot);
  const pythonRoots = findPythonRoots(repoRoot);

  if (!stackRoots.length && !pythonRoots.length) {
    console.error("No Express/React package.json or Python project found under", repoRoot);
    process.exit(1);
  }

  const backendAnalyses = stackRoots
    .filter((s) => s.kind === "backend")
    .map((s) => analyzeBackend(s));

  const allFindings = backendAnalyses.flatMap((b) => scanRisks(b));

  const apiRef = genApiReference(backendAnalyses);
  const arch = genArchitecture(stackRoots, backendAnalyses);
  const flows = genFlows(backendAnalyses);
  const risk = genRiskReport(allFindings);

  if (stackRoots.length) {
    fs.writeFileSync(path.join(outDir, "API_REFERENCE.md"), apiRef);
    fs.writeFileSync(path.join(outDir, "ARCHITECTURE.md"), arch);
    fs.writeFileSync(path.join(outDir, "FLOWS.md"), flows);
    fs.writeFileSync(path.join(outDir, "RISK_REPORT.md"), risk);
  }

  // Python: run per detected root (one requirements.txt/pyproject.toml = one project)
  const pythonResults = [];
  for (const pyRoot of pythonRoots) {
    console.log(`Running pytest for ${pyRoot.name}...`);
    const pytestResult = runPytest(pyRoot);
    const pyFindings = scanPythonRisks(pyRoot);
    const pyMd = genPythonReport(pyRoot, pytestResult, pyFindings);
    const safeName = pyRoot.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    fs.writeFileSync(path.join(outDir, `PYTHON_REPORT_${safeName}.md`), pyMd);
    pythonResults.push({ root: pyRoot, pytestResult, findings: pyFindings });
  }

  fs.writeFileSync(
    path.join(outDir, "audit-data.json"),
    JSON.stringify(
      {
        stackRoots: stackRoots.map((s) => ({ name: s.name, kind: s.kind, dir: s.dir })),
        backendAnalyses: backendAnalyses.map((b) => ({
          stackName: b.stackName,
          dirs: b.dirs,
          routeCount: b.routes.length,
          routes: b.routes,
          controllerFiles: b.controllerFiles,
          modelFiles: b.modelFiles,
          serviceFiles: b.serviceFiles,
        })),
        findings: allFindings,
        python: pythonResults.map((r) => ({
          name: r.root.name,
          dir: r.root.dir,
          pytest: r.pytestResult,
          findings: r.findings,
        })),
      },
      null,
      2
    )
  );

  console.log(`Wrote audit output to ${outDir}`);
  if (backendAnalyses.length) {
    console.log(`  Routes analyzed: ${backendAnalyses.reduce((n, b) => n + b.routes.length, 0)}`);
    console.log(`  JS/TS findings: ${allFindings.length} (${allFindings.filter(f=>f.severity==='high').length} high, ${allFindings.filter(f=>f.severity==='medium').length} medium, ${allFindings.filter(f=>f.severity==='low').length} low)`);
  }
  for (const r of pythonResults) {
    const testSummary = r.pytestResult.ran && r.pytestResult.parsed
      ? `${r.pytestResult.passRate}% pass rate (${r.pytestResult.counts.passed}/${r.pytestResult.total})`
      : `tests not run (${r.pytestResult.reason || "unparsed output"})`;
    console.log(`  Python (${r.root.name}): ${testSummary}, ${r.findings.length} risk findings`);
  }
}

main();
