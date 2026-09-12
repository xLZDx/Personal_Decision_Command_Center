#!/usr/bin/env node
/**
 * Manifest-proposal bootstrap path (closes G1 closure-review BLOCKER 2).
 *
 * Problem this exists to solve: once `main` is ruleset-protected (no bypass actors, PR + required
 * checks mandatory), there is no way to ever introduce the NEXT gate's manifest candidate.
 * `g1.yaml` itself only reached `main` because it was pushed directly, before that ruleset existed
 * -- a PR labeled `Gate: G1` hits `g1.yaml`'s own `forbidden_paths` on any
 * `governance/gate-manifests/**` touch, and a PR labeled for a future gate fails at the hash step
 * because no manifest/approved-hash exists for it yet. Both paths dead-end.
 *
 * The fix: a distinct branch-naming convention, `manifest-proposal/g<N>`, that can never collide
 * with `gate/g<N>-...` (ordinary gate work). A PR on such a branch is validated HERE, narrowly:
 * its cumulative diff must be EXACTLY one file, `governance/gate-manifests/g<N>.yaml`, and that
 * gate's approval-hash variable must currently be UNSET (a genuinely new, not-yet-adopted
 * candidate -- never a revision of something already binding, which would be an ordinary gate's
 * own scope-checked content change instead). If the branch uses this naming convention at all, it
 * is this check's PR to validate -- it never silently falls through to ordinary gate resolution,
 * because a proposal that fails these conditions is exactly the self-authorization attempt this
 * mechanism exists to catch, not an ordinary content change to be judged some other way.
 *
 * This restores exactly the capability the direct-push bootstrap used to provide (implementer
 * proposes candidate bytes, operator reviews and adopts by setting the hash) through the PR path,
 * with no ruleset bypass and no widening of any adopted gate's own scope.
 */

import { pathToFileURL } from 'node:url';
import { changedPathsFrom } from './check-gate-scope.mjs';

export const PROPOSAL_BRANCH_RE = /^manifest-proposal\/([gG][0-9]+)$/;

/**
 * @param {string} branch
 * @returns {{ isProposalBranch: boolean, gate?: string }}
 */
export function detectProposalBranch(branch) {
  const match = PROPOSAL_BRANCH_RE.exec(branch ?? '');
  if (!match) return { isProposalBranch: false };
  return { isProposalBranch: true, gate: match[1].toUpperCase() };
}

/**
 * Pure validation over already-computed inputs -- no process, no git, no environment.
 *
 * @param {{ gate: string, changedPaths: string[], approvedHash: string|undefined }} input
 * @returns {{ valid: boolean, errors: string[], expectedPath: string }}
 */
export function validateProposal({ gate, changedPaths, approvedHash }) {
  const errors = [];
  const expectedPath = `governance/gate-manifests/${gate.toLowerCase()}.yaml`;

  if (changedPaths.length !== 1) {
    errors.push(
      `a manifest-proposal PR must change exactly one file; this PR changes ${changedPaths.length}: ` +
        changedPaths.join(', '),
    );
  } else if (changedPaths[0] !== expectedPath) {
    errors.push(
      `branch manifest-proposal/${gate.toLowerCase()} must change ${expectedPath}, not ${changedPaths[0]}.`,
    );
  }

  if (approvedHash) {
    errors.push(
      `GATE_MANIFEST_APPROVED_HASH_${gate} is already set -- ${gate} is already adopted. A ` +
        `manifest-proposal PR is only for a gate with no approved hash yet; revising an adopted ` +
        `manifest is that gate's own scope-checked content change, not a proposal.`,
    );
  }

  return { valid: errors.length === 0, errors, expectedPath };
}

/**
 * The whole CLI, as a function that RETURNS an exit code instead of calling process.exit.
 *
 * Mirrors check-gate-scope.mjs / check-test-deletion.mjs: every guarantee is expressed in the
 * return value, not buried in an untestable main(), and dependencies are injected so the exit
 * paths can be exercised without a real repository or environment.
 *
 * @returns {0|1} process exit code
 */
export function run({
  env,
  cwd,
  listChangedPaths = changedPathsFrom,
  log = console.log,
  logError = console.error,
} = {}) {
  const branch = env?.BRANCH;
  const baseSha = env?.BASE_SHA;
  const headSha = env?.HEAD_SHA;
  const allVarsRaw = env?.ALL_VARS;

  const { isProposalBranch, gate } = detectProposalBranch(branch);

  if (!isProposalBranch) {
    log('Not a manifest-proposal branch; ordinary gate resolution applies.');
    return 0;
  }

  if (!baseSha || !headSha) {
    logError('::error::BASE_SHA and HEAD_SHA must be set (pull_request context).');
    return 1;
  }

  let allVars;
  try {
    allVars = JSON.parse(allVarsRaw ?? '{}');
  } catch (error) {
    logError(`::error::could not parse repository variables: ${error.message}`);
    return 1;
  }

  let changedPaths;
  try {
    changedPaths = listChangedPaths(baseSha, headSha, cwd);
  } catch (error) {
    logError(`::error::could not list the changed paths: ${error.message}`);
    return 1;
  }

  const approvedHash = allVars[`GATE_MANIFEST_APPROVED_HASH_${gate}`];
  const { valid, errors, expectedPath } = validateProposal({ gate, changedPaths, approvedHash });

  log(`Manifest-proposal branch detected: proposing ${expectedPath}.`);
  log(`Changed paths (${changedPaths.length}):`);
  for (const p of changedPaths) log(`  ${p}`);

  if (!valid) {
    logError('::error::This manifest-proposal PR is invalid:');
    for (const e of errors) logError(`::error::  - ${e}`);
    logError(
      '::error::A branch named manifest-proposal/g<N> is validated by this check alone -- it ' +
        'never falls through to ordinary gate resolution.',
    );
    return 1;
  }

  log(
    `Valid manifest proposal for ${gate}: exactly ${expectedPath} changed, no approved hash ` +
      `exists yet. This PR carries no binding scope -- it becomes real only when the operator ` +
      `reviews these bytes and sets GATE_MANIFEST_APPROVED_HASH_${gate} (INV-28).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run({ env: process.env, cwd: process.cwd() });
}
