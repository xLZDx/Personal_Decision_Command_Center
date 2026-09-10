#!/usr/bin/env node
/**
 * Gate-scope check: every path a PR changes must be inside its gate manifest's approved scope.
 *
 * Runs ONLY after the manifest's sha256 has been matched against the operator-held repository
 * variable (see .github/workflows/governance.yml). Validating a diff against a manifest whose
 * integrity was never established is circular -- the diff could have rewritten the manifest that
 * authorizes it. That is NM3 from the v0.2 adversarial review.
 *
 * Why this is Node and not `yq` in the workflow: the previous shell implementation depended on
 * `yq` flag and expression semantics that differ between the Go and Python implementations of that
 * command, and CI on this repository currently executes nothing (R11), so nothing about the shell
 * version could be verified before merging it. This can be run and mutation-tested locally, which
 * is the only evidence available right now.
 *
 * The manifest is read with a deliberately tiny YAML subset reader rather than a YAML library:
 * a gate manifest is a governance document a human has to audit and hash-approve, so anchors,
 * aliases, merge keys and flow style are rejected outright instead of silently honored. Anything
 * the reader does not understand is an error, never a silently empty list.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Extract a top-level block sequence of strings.
 *
 * Returns null when the key is absent, so the caller decides whether absence is fatal --
 * a missing `allowed_paths` must fail, a missing `forbidden_paths` is simply an empty list.
 */
export function parsePathList(text, key) {
  const lines = text.split(/\r?\n/);
  const headerIndexes = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(`${key}:`)) headerIndexes.push(i);
  }

  if (headerIndexes.length === 0) return null;
  if (headerIndexes.length > 1) {
    throw new Error(
      `${key} appears ${headerIndexes.length} times at the top level. A duplicate key means the ` +
        `list a reader sees and the list this check enforces may differ.`,
    );
  }

  const header = lines[headerIndexes[0]];
  const rest = header.slice(key.length + 1).trim();
  if (rest !== '' && !rest.startsWith('#')) {
    throw new Error(
      `${key} must be a block sequence (one "  - value" per line). Flow style and inline values ` +
        `are rejected: got ${JSON.stringify(rest)}.`,
    );
  }

  const items = [];
  for (let i = headerIndexes[0] + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      // A non-indented line ends the block ONLY if it really is the next top-level key.
      //
      // This used to be a bare `break`, and that was a defect an internal security review found:
      // a list item that lost its indent (`forbidden_paths:` followed by an unindented
      // `- secrets/**`) took the same branch, so the reader returned an empty list with no error.
      // For `forbidden_paths` that is silently zero enforcement -- and it is invisible, because
      // an empty list is exactly what a manifest that declares no forbidden paths produces.
      // A manifest that reads correctly to a human must not parse to nothing.
      if (/^[A-Za-z_][A-Za-z0-9_.-]*:/.test(line)) break;
      throw new Error(
        `Unsupported line inside ${key} at line ${i + 1}: ${JSON.stringify(line)}. A list entry ` +
          `must be indented ("  - value"), and an unindented line here is not a valid next key.`,
      );
    }

    const item = /^\s+-\s+(.*)$/.exec(line);
    if (!item) {
      throw new Error(
        `Unsupported line inside ${key} at line ${i + 1}: ${JSON.stringify(line)}. Only ` +
          `"  - value" entries are accepted.`,
      );
    }
    items.push(readScalar(item[1], key, i + 1));
  }

  // Present-but-empty is rejected rather than returned. An empty list read from a key that is
  // physically there cannot be told apart from a list this reader failed to read, and for
  // `forbidden_paths` the two have opposite consequences.
  if (items.length === 0) {
    throw new Error(
      `${key} is present but declares no entries. Omit the key entirely if that is intended.`,
    );
  }

  return items;
}

function readScalar(raw, key, lineNo) {
  let value = raw.trim();

  const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(value);
  if (quoted) {
    value = quoted[1] ?? quoted[2];
  } else {
    value = value.replace(/\s+#.*$/, '').trim();
    // Two separate checks, not one `||`: a combined condition can lose half of itself without any
    // test noticing, which an internal review flagged here specifically.
    if (value.startsWith('*')) {
      throw new Error(
        `${key} line ${lineNo}: ${JSON.stringify(value)} is a YAML alias or anchor. A pattern ` +
          `beginning with "*" must be quoted, e.g. - "*.md".`,
      );
    }
    if (value.startsWith('&')) {
      throw new Error(
        `${key} line ${lineNo}: ${JSON.stringify(value)} is a YAML alias or anchor. Anchors are ` +
          `not accepted in a manifest a human has to audit.`,
      );
    }
    if (/^[|>]/.test(value)) {
      throw new Error(`${key} line ${lineNo}: block scalars are not accepted.`);
    }
  }

  if (value === '') {
    throw new Error(`${key} line ${lineNo}: empty pattern.`);
  }
  return value;
}

/**
 * Compile one manifest pattern to an anchored RegExp.
 *
 * Grammar, deliberately narrower than shell globbing:
 *   `**`  a whole segment; matches any number of segments
 *   `*`   within one segment only -- it does NOT cross `/`
 *   any other character is literal
 *
 * The previous shell check used bash `[[ path == pattern ]]`, where `*` DOES cross `/`, so
 * `packages/*` silently authorized `packages/anything/deep/file.ts`. Segment-bounded `*` is the
 * stricter reading, and a manifest that really means "everything below here" says `**`.
 */
export function compilePattern(pattern) {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error('empty pattern');
  }
  if (pattern.startsWith('/')) {
    throw new Error(`${pattern}: patterns are repository-relative and must not start with "/".`);
  }
  if (pattern.includes('\\')) {
    throw new Error(`${pattern}: use "/" as the separator; git paths never contain "\\".`);
  }
  if (pattern.includes('//')) {
    throw new Error(`${pattern}: empty path segment.`);
  }

  const segments = pattern.split('/');
  let source = '';

  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;

    if (segment === '.' || segment === '..') {
      throw new Error(`${pattern}: "." and ".." segments are not accepted.`);
    }
    if (segment.includes('**') && segment !== '**') {
      throw new Error(`${pattern}: "**" must be a whole segment, e.g. "docs/**/notes.md".`);
    }

    if (segment === '**') {
      // `packages/**` compiles to `^packages/.+$`, so it covers everything below `packages/`
      // and, because the separator is part of the pattern, never the bare directory name.
      source += isLast ? '.+' : '(?:[^/]+/)*';
      return;
    }

    source += segment.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '[^/]*' : `\\${ch}`));
    if (!isLast) source += '/';
  });

  return new RegExp(`^${source}$`);
}

export function matches(path, pattern) {
  return compilePattern(pattern).test(path);
}

/**
 * @returns {{violations: {path: string, pattern: string|null}[], vacuous: string[]}}
 */
export function checkScope({ changedPaths, allowed, forbidden = [] }) {
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new Error('allowed_paths is missing or empty; refusing to evaluate scope against it.');
  }

  const allowedRe = allowed.map((p) => ({ pattern: p, re: compilePattern(p) }));
  const forbiddenRe = forbidden.map((p) => ({ pattern: p, re: compilePattern(p) }));

  const violations = [];
  for (const path of changedPaths) {
    const hit = forbiddenRe.find((f) => f.re.test(path));
    if (hit) {
      violations.push({ path, pattern: hit.pattern });
      continue;
    }
    if (!allowedRe.some((a) => a.re.test(path))) {
      violations.push({ path, pattern: null });
    }
  }

  // A pattern that matches every possible path makes the check indistinguishable from no check.
  // Reported, not rejected: the manifest is the operator's document, so this warns rather than
  // overriding it -- but it must never pass silently.
  const vacuous = allowed.filter((p) => p === '**');

  return { violations, vacuous };
}

export function changedPathsFrom(baseSha, headSha, cwd) {
  const out = execFileSync('git', ['diff', '--name-only', '-z', `${baseSha}...${headSha}`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // `-z` because git otherwise quotes and backslash-escapes unusual filenames, and an escaped
  // path would be matched against patterns written in terms of the real one.
  return out.split('\0').filter((p) => p !== '');
}

/**
 * The whole CLI, as a function that RETURNS an exit code instead of calling process.exit.
 *
 * Every guarantee this file exists to provide is expressed here, not in the pure helpers: "CI
 * fails the build when the scope is violated" IS the `return 1` below. An internal review pointed
 * out that the previous version buried all of it in an untestable `main()`, so a regression that
 * dropped an exit path would have left all twenty unit tests green while the check exited 0 on a
 * real violation. Dependencies are injected for the same reason -- so the exit paths can be
 * exercised without a git repository or a real environment.
 *
 * @returns {0|1} process exit code
 */
export function run({
  env,
  cwd,
  readFile = (p) => readFileSync(p, 'utf8'),
  listChangedPaths = changedPathsFrom,
  log = console.log,
  logError = console.error,
} = {}) {
  const gate = env?.GATE;
  const manifestPath = env?.MANIFEST;
  const baseSha = env?.BASE_SHA;
  const headSha = env?.HEAD_SHA;

  for (const [name, value] of Object.entries({
    GATE: gate,
    MANIFEST: manifestPath,
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
  })) {
    if (!value) {
      logError(`::error::${name} is not set; refusing to run a check that cannot be complete.`);
      return 1;
    }
  }

  let text;
  try {
    text = readFile(manifestPath);
  } catch (error) {
    logError(`::error::${manifestPath} could not be read: ${error.message}`);
    return 1;
  }

  let allowed;
  let forbidden;
  try {
    allowed = parsePathList(text, 'allowed_paths');
    forbidden = parsePathList(text, 'forbidden_paths') ?? [];
  } catch (error) {
    logError(`::error::${manifestPath} could not be read: ${error.message}`);
    return 1;
  }

  if (allowed === null) {
    logError(`::error::${manifestPath} declares no allowed_paths, so it defines no scope.`);
    return 1;
  }

  let changedPaths;
  try {
    changedPaths = listChangedPaths(baseSha, headSha, cwd);
  } catch (error) {
    logError(`::error::could not list the changed paths: ${error.message}`);
    return 1;
  }

  log(`Changed paths (${changedPaths.length}):`);
  for (const p of changedPaths) log(`  ${p}`);

  let result;
  try {
    result = checkScope({ changedPaths, allowed, forbidden });
  } catch (error) {
    logError(`::error::${manifestPath}: ${error.message}`);
    return 1;
  }

  for (const pattern of result.vacuous) {
    log(
      `::warning::${manifestPath} allows "${pattern}", which matches every path. This gate's ` +
        `scope check cannot refuse anything while that entry is present.`,
    );
  }

  for (const { path, pattern } of result.violations) {
    logError(
      pattern === null
        ? `::error file=${path}::outside ${gate}'s approved scope`
        : `::error file=${path}::forbidden by the ${gate} manifest (pattern: ${pattern})`,
    );
  }

  if (result.violations.length > 0) {
    logError(
      `::error::${result.violations.length} path(s) outside the approved scope for ${gate}. ` +
        `Widening the manifest to fit the diff is not the fix -- a scope change needs a new plan ` +
        `and a new GO.`,
    );
    return 1;
  }

  log(`All ${changedPaths.length} changed path(s) are within ${gate}'s approved scope.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `exitCode` rather than `exit()`: the latter can terminate the process before stdout has
  // flushed, which would drop the very annotations CI is meant to display.
  process.exitCode = run({ env: process.env, cwd: process.cwd() });
}
