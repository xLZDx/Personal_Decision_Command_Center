import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression suite for a removed control, not a live one.
 *
 * This file used to test `scripts/verify/check-floor-scope.mjs`, the enforcement code for a
 * "Gate: NONE" ungated PR path. That path was removed as a G1 closure BLOCKER (GPT-PM review,
 * 2026-09-12): the floor's own FORBIDDEN_PATHS did not include `scripts/verify/**`, so an ungated
 * PR could edit the very script that was supposed to constrain it, and CI would run the EDITED
 * version from that PR's own checkout and see nothing wrong -- widening the forbidden list would
 * only have moved the same self-modification problem, not closed it. See
 * `governance/plans/G1_PREADOPTION_EVIDENCE.md` for the full finding and its remediation.
 *
 * What this file asserts now: the source no longer contains an ungated path, and the file that
 * used to implement it is gone. That is a STATIC guarantee, not a behavioral one -- the real
 * behavioral proof (a genuine CI run showing a no-gate PR refused before any PR-controlled scope
 * code executes) lives in `governance/plans/G1_PREADOPTION_EVIDENCE.md` as a real run id, on the
 * `control/g1-none-rejection` branch, because bash embedded in a workflow YAML step has no module
 * boundary a unit test can import and exercise directly.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the "Gate: NONE" ungated path is gone, not merely narrowed', () => {
  it('check-floor-scope.mjs no longer exists', () => {
    expect(existsSync(join(REPO, 'scripts', 'verify', 'check-floor-scope.mjs'))).toBe(false);
  });

  it('governance.yml no longer resolves a NONE gate from the PR body', () => {
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'governance.yml'), 'utf8');
    // Scoped to the executable body (from `jobs:` on) -- the header comment intentionally
    // documents the removed "Gate: NONE" path and check-floor-scope.mjs by name, historically,
    // the same way TDD_ERRATA.md E-001 names the workflow files it replaced.
    const body = workflow.slice(workflow.indexOf('\njobs:'));
    expect(body).not.toMatch(/gate="NONE"/);
    expect(body).not.toMatch(/\[\[\s*"\$GATE"\s*==\s*"NONE"\s*\]\]/);
    expect(body).not.toMatch(/\[\[\s*"\$gate"\s*==\s*"NONE"\s*\]\]/);
    expect(body).not.toMatch(/steps\.gate\.outputs\.gate\s*!=\s*'NONE'/);
    expect(body).not.toContain('check-floor-scope.mjs');
  });

  it('governance.yml still fails gate resolution unconditionally when no gate is named', () => {
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'governance.yml'), 'utf8');
    expect(workflow).toContain('This PR declares no gate');
    expect(workflow).toMatch(/if \[\[ -z "\$gate" \]\]; then[\s\S]*?exit 1/);
  });

  it('the manifest-hash step is no longer conditional on the gate NOT being NONE', () => {
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'governance.yml'), 'utf8');
    // Before this fix: `if: steps.gate.outputs.gate != 'NONE'` guarded this step. Its removal
    // means the hash check now runs for every resolved gate unconditionally.
    const hashStepIndex = workflow.indexOf(
      'Verify manifest hash against operator-controlled state',
    );
    const nextStepIndex = workflow.indexOf('Check changed paths against the verified scope');
    const hashStepBlock = workflow.slice(hashStepIndex, nextStepIndex);
    expect(hashStepBlock).not.toMatch(/if:\s*steps\.gate\.outputs\.gate/);
  });

  it('the scope step always runs check-gate-scope.mjs, with no branch for a floor script', () => {
    const workflow = readFileSync(join(REPO, '.github', 'workflows', 'governance.yml'), 'utf8');
    const scopeStepIndex = workflow.indexOf('Check changed paths against the verified scope');
    const scopeStepBlock = workflow.slice(scopeStepIndex);
    expect(scopeStepBlock).toContain('check-gate-scope.mjs');
    expect(scopeStepBlock).not.toContain('check-floor-scope.mjs');
    expect(scopeStepBlock).not.toMatch(/if \[\[ "\$GATE" == "NONE" \]\]/);
  });
});
