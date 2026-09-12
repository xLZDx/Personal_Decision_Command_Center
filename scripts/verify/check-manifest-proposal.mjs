#!/usr/bin/env node
/**
 * Manifest bootstrap/amendment guard (closes G1 closure-review BLOCKER 2; corrected after GPT-PM's
 * round-1 review of this file's first version found the correction itself wrong).
 *
 * Problem this exists to solve: once `main` is ruleset-protected (no bypass actors, PR + required
 * checks mandatory), there is no way to ever introduce a NEW gate's manifest, or revise an already
 * ADOPTED one. `g1.yaml` itself only reached `main` because it was pushed directly, before that
 * ruleset existed -- a PR labeled `Gate: G1` hits `g1.yaml`'s own `forbidden_paths` on any
 * `governance/gate-manifests/**` touch, and a PR labeled for a future gate fails at the ordinary
 * hash step because no manifest exists for it yet. Both paths dead-end.
 *
 * FIRST VERSION OF THIS FIX WAS WRONG, and the wrongness is worth keeping on record rather than
 * silently overwriting: it treated "no approved hash exists yet" as sufficient to admit ANY new
 * candidate bytes sight-unseen, trusting the merge-time review (global CLAUDE.md §24) as the only
 * gate. GPT-PM's round-1 review caught that this inverts the actual approved protocol -- the
 * pre-approved-hash-then-verify-EQUALITY model the ORDINARY hash check already uses for an adopted
 * gate -- and that inversion means CI itself offers zero resistance to an unreviewed manifest; only
 * the merge process does. That is a real, avoidable weakening of defense-in-depth this gate's own
 * `GATE_MANIFEST_INTEGRITY.md` argues for everywhere else (hash-before-scope, in one job, so a
 * tampered manifest never authorizes its own diff).
 *
 * THE CORRECTED MODEL: identical in shape to the ordinary hash check. A branch below carries
 * exactly one file -- the gate's own manifest -- and CI computes that file's sha256 and compares it
 * to the operator-controlled `GATE_MANIFEST_APPROVED_HASH_<GATE>` repository variable, passing ONLY
 * on an exact match. The operator must review the exact candidate bytes (the PR's real diff on
 * GitHub, or the file shared directly) and set the variable to match BEFORE this check can go
 * green -- mirroring exactly how `g1.yaml` itself was bootstrapped (CI prints the computed hash on
 * failure so the operator can read it off a real run, never as a substitute for reading the file).
 *
 * TWO BRANCH NAMES, ONE CHECK: `manifest-proposal/g<N>` names a gate with no manifest file on
 * `main` yet (a genuine first adoption); `manifest-amendment/g<N>` names a revision to an already-
 * adopted gate's manifest. The distinction exists for audit clarity -- which of the two a reader
 * is looking at -- not because the underlying validation differs: what actually matters is only
 * whether the CURRENT operator-set variable matches the CURRENT candidate bytes, never whether a
 * hash existed before this PR.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { changedPathsFrom } from './check-gate-scope.mjs';

export const PROPOSAL_BRANCH_RE = /^manifest-proposal\/([gG][0-9]+)$/;
export const AMENDMENT_BRANCH_RE = /^manifest-amendment\/([gG][0-9]+)$/;

/**
 * @param {string} branch
 * @returns {{ isManifestBranch: boolean, kind: 'proposal'|'amendment'|null, gate: string|null }}
 */
export function detectManifestBranch(branch) {
  const proposal = PROPOSAL_BRANCH_RE.exec(branch ?? '');
  if (proposal) {
    return { isManifestBranch: true, kind: 'proposal', gate: proposal[1].toUpperCase() };
  }
  const amendment = AMENDMENT_BRANCH_RE.exec(branch ?? '');
  if (amendment) {
    return { isManifestBranch: true, kind: 'amendment', gate: amendment[1].toUpperCase() };
  }
  return { isManifestBranch: false, kind: null, gate: null };
}

/**
 * Pure validation over already-computed inputs -- no process, no git, no environment.
 *
 * @param {{ kind: 'proposal'|'amendment', gate: string, changedPaths: string[],
 *           approvedHash: string|undefined, candidateHash: string|null }} input
 * @returns {{ valid: boolean, errors: string[], expectedPath: string }}
 */
export function validateManifestChange({ kind, gate, changedPaths, approvedHash, candidateHash }) {
  const errors = [];
  const expectedPath = `governance/gate-manifests/${gate.toLowerCase()}.yaml`;
  const branchLabel = `${kind === 'proposal' ? 'manifest-proposal' : 'manifest-amendment'}/${gate.toLowerCase()}`;

  if (changedPaths.length !== 1) {
    errors.push(
      `a ${kind} PR must change exactly one file; this PR changes ${changedPaths.length}: ` +
        changedPaths.join(', '),
    );
  } else if (changedPaths[0] !== expectedPath) {
    errors.push(`branch ${branchLabel} must change ${expectedPath}, not ${changedPaths[0]}.`);
  }

  // candidateHash is only computed by run() when the single-file check above already passed --
  // absent here means that check failed, and its own error is enough; do not also emit a
  // misleading hash complaint about a file that was never the one actually evaluated.
  if (candidateHash !== null) {
    if (!approvedHash) {
      errors.push(
        `GATE_MANIFEST_APPROVED_HASH_${gate} is not set. The operator must review these exact ` +
          `candidate bytes and set it to ${candidateHash} -- ONLY if they actually reviewed the ` +
          `file. This is not a substitute for reading the manifest.`,
      );
    } else if (approvedHash !== candidateHash) {
      errors.push(
        `GATE_MANIFEST_APPROVED_HASH_${gate} (${approvedHash}) does not match this candidate's ` +
          `bytes (${candidateHash}). Set it to the printed value only after reviewing these exact ` +
          `bytes, or revise the candidate to match what was already approved.`,
      );
    }
  }

  return { valid: errors.length === 0, errors, expectedPath };
}

/**
 * The whole CLI, as a function that RETURNS an exit code instead of calling process.exit.
 *
 * @returns {0|1} process exit code
 */
export function run({
  env,
  cwd = process.cwd(),
  listChangedPaths = changedPathsFrom,
  readManifestBytes = (path) => readFileSync(path),
  log = console.log,
  logError = console.error,
} = {}) {
  const branch = env?.BRANCH;
  const baseSha = env?.BASE_SHA;
  const headSha = env?.HEAD_SHA;
  const allVarsRaw = env?.ALL_VARS;

  const { isManifestBranch, kind, gate } = detectManifestBranch(branch);

  if (!isManifestBranch) {
    log('Not a manifest-proposal/amendment branch; ordinary gate resolution applies.');
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

  const expectedPath = `governance/gate-manifests/${gate.toLowerCase()}.yaml`;
  const label = kind === 'proposal' ? 'Manifest-proposal' : 'Manifest-amendment';

  log(`${label} branch detected: ${expectedPath}.`);
  log(`Changed paths (${changedPaths.length}):`);
  for (const p of changedPaths) log(`  ${p}`);

  let candidateHash = null;
  if (changedPaths.length === 1 && changedPaths[0] === expectedPath) {
    try {
      const bytes = readManifestBytes(join(cwd, expectedPath));
      candidateHash = createHash('sha256').update(bytes).digest('hex');
      log(`actual:   ${candidateHash}`);
    } catch (error) {
      logError(`::error::could not read ${expectedPath} to compute its hash: ${error.message}`);
      return 1;
    }
  }

  const approvedHash = allVars[`GATE_MANIFEST_APPROVED_HASH_${gate}`];
  const { valid, errors } = validateManifestChange({
    kind,
    gate,
    changedPaths,
    approvedHash,
    candidateHash,
  });

  if (!valid) {
    logError(`::error::This ${kind} PR is invalid:`);
    for (const e of errors) logError(`::error::  - ${e}`);
    logError(
      `::error::A branch named ${kind === 'proposal' ? 'manifest-proposal' : 'manifest-amendment'}` +
        '/g<N> is validated by this check alone -- it never falls through to ordinary gate resolution.',
    );
    return 1;
  }

  log(
    `Valid ${kind} for ${gate}: ${expectedPath} matches the operator-approved ` +
      `GATE_MANIFEST_APPROVED_HASH_${gate}. This PR carries no binding scope beyond the manifest ` +
      `file itself (INV-28).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run({ env: process.env, cwd: process.cwd() });
}
