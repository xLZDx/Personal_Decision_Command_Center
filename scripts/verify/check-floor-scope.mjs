#!/usr/bin/env node
/**
 * Floor scope check: what a "Gate: NONE" PR (see .github/workflows/governance.yml) may touch.
 *
 * Every real gate's own manifest (governance/gate-manifests/*.yaml) forbids editing
 * governance/gate-manifests/** by design (INV-28): an implementer cannot land a new or edited
 * manifest through a gate-labeled PR, because that PR's own diff could then be validated against
 * a manifest the same diff had just written -- NM3 from the v0.2 adversarial review. That
 * property has to hold for the floor an UNGATED PR is checked against too. It was first drafted
 * as governance/gate-manifests/_floor.yaml, a YAML manifest read from disk -- but that would have
 * needed exactly the ceremony a real manifest needs (operator-authored-or-adopted, landed outside
 * the normal PR/scope-check path), and there is no route left that could ever land it: a
 * gate-labeled PR is forbidden from touching governance/gate-manifests/** by every existing
 * manifest, an ungated PR would be forbidden from touching it by the very file being introduced,
 * and branch protection now requires every change go through one of those two kinds of PR. So the
 * floor's rules live here instead, as ordinary code under scripts/verify/ -- the same file class
 * as check-gate-scope.mjs itself, changeable through whichever gate's own manifest permits editing
 * scripts/verify/*.mjs. That is exactly as protected as the enforcement mechanism as a whole, no
 * more and no less. What still holds regardless of where this lives: FORBIDDEN_PATHS below still
 * blocks an ungated PR from touching governance/gate-manifests/** or any other sensitive path, so
 * being ungated is never itself a way to acquire broader authority.
 *
 * Reuses checkScope/changedPathsFrom from check-gate-scope.mjs rather than re-implementing scope
 * evaluation -- one audited pattern engine, not two.
 */

import { changedPathsFrom, checkScope } from './check-gate-scope.mjs';
import { pathToFileURL } from 'node:url';

// A bare "**" is deliberate here, not an oversight: checkScope() reports it as "vacuous" (a
// warning, never a failure) -- that warning exists to catch an ACCIDENTAL bare "**" in a real
// per-gate manifest, where it would mean the manifest refuses nothing. Here it is the whole point:
// an ungated PR may touch anything not listed in FORBIDDEN_PATHS below.
export const ALLOWED_PATHS = ['**'];

export const FORBIDDEN_PATHS = [
  // Every per-gate manifest. An ungated PR can never touch gate-scope authority -- the same
  // forbidden entry every real gate manifest already carries for itself.
  'governance/gate-manifests/**',

  // The operator's own record of what they approved.
  'governance/operator-approvals/**',

  // The frozen architecture baseline.
  'docs/architecture/TDD.md',

  // The enforcement mechanism itself, and the file that protects it from casual editing.
  '.github/workflows/**',
  '.github/CODEOWNERS',
];

/**
 * @returns {0|1} process exit code
 */
export function run({
  env,
  cwd,
  listChangedPaths = changedPathsFrom,
  log = console.log,
  logError = console.error,
} = {}) {
  const baseSha = env?.BASE_SHA;
  const headSha = env?.HEAD_SHA;

  for (const [name, value] of Object.entries({ BASE_SHA: baseSha, HEAD_SHA: headSha })) {
    if (!value) {
      logError(`::error::${name} is not set; refusing to run a check that cannot be complete.`);
      return 1;
    }
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

  const result = checkScope({ changedPaths, allowed: ALLOWED_PATHS, forbidden: FORBIDDEN_PATHS });

  for (const pattern of result.vacuous) {
    log(
      `::warning::the floor allows "${pattern}", which matches every path not otherwise ` +
        `forbidden. That is deliberate for an ungated PR -- see this file's header.`,
    );
  }

  for (const { path, pattern } of result.violations) {
    logError(`::error file=${path}::forbidden for an ungated PR (pattern: ${pattern})`);
  }

  if (result.violations.length > 0) {
    logError(
      `::error::${result.violations.length} path(s) forbidden for a "Gate: NONE" PR. If this ` +
        `change genuinely needs one of those paths, it belongs to a real gate, not "Gate: NONE" ` +
        `-- name the gate it belongs to instead.`,
    );
    return 1;
  }

  log(`All ${changedPaths.length} changed path(s) are within the ungated floor.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `exitCode` rather than `exit()`: the latter can terminate the process before stdout has
  // flushed, which would drop the very annotations CI is meant to display.
  process.exitCode = run({ env: process.env, cwd: process.cwd() });
}
