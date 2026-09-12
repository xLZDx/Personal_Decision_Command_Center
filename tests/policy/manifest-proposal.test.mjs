import { describe, expect, it, vi } from 'vitest';

import {
  detectProposalBranch,
  run,
  validateProposal,
} from '../../scripts/verify/check-manifest-proposal.mjs';

describe('detectProposalBranch', () => {
  it('recognizes manifest-proposal/g<N>, case-insensitive on the gate letter', () => {
    expect(detectProposalBranch('manifest-proposal/g2')).toEqual({
      isProposalBranch: true,
      gate: 'G2',
    });
    expect(detectProposalBranch('manifest-proposal/G10')).toEqual({
      isProposalBranch: true,
      gate: 'G10',
    });
  });

  it('never matches ordinary gate/g<N>-... branches', () => {
    expect(detectProposalBranch('gate/g1-remediation').isProposalBranch).toBe(false);
    expect(detectProposalBranch('gate/g2-manifest-proposal').isProposalBranch).toBe(false);
  });

  it('rejects anything not an exact manifest-proposal/g<N> match', () => {
    expect(detectProposalBranch('manifest-proposal/g2-extra').isProposalBranch).toBe(false);
    expect(detectProposalBranch('manifest-proposal/').isProposalBranch).toBe(false);
    expect(detectProposalBranch('manifest-proposal/g').isProposalBranch).toBe(false);
    expect(detectProposalBranch('').isProposalBranch).toBe(false);
    expect(detectProposalBranch(undefined).isProposalBranch).toBe(false);
  });
});

describe('validateProposal', () => {
  it('accepts exactly one new manifest file for a gate with no approved hash', () => {
    const result = validateProposal({
      gate: 'G2',
      changedPaths: ['governance/gate-manifests/g2.yaml'],
      approvedHash: undefined,
    });
    expect(result).toEqual({
      valid: true,
      errors: [],
      expectedPath: 'governance/gate-manifests/g2.yaml',
    });
  });

  it('rejects more than one changed file, even if the manifest is among them', () => {
    const result = validateProposal({
      gate: 'G2',
      changedPaths: ['governance/gate-manifests/g2.yaml', '.github/workflows/governance.yml'],
      approvedHash: undefined,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/exactly one file/);
  });

  it('rejects a lone changed file that is not the expected manifest path', () => {
    const result = validateProposal({
      gate: 'G2',
      changedPaths: ['governance/gate-manifests/g3.yaml'],
      approvedHash: undefined,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must change governance\/gate-manifests\/g2\.yaml/);
  });

  it('rejects proposing a gate that is already adopted', () => {
    const result = validateProposal({
      gate: 'G1',
      changedPaths: ['governance/gate-manifests/g1.yaml'],
      approvedHash: 'e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/already adopted/);
  });

  it('rejects both a wrong path AND an already-adopted gate at once, reporting both', () => {
    const result = validateProposal({
      gate: 'G1',
      changedPaths: ['governance/gate-manifests/g1.yaml', 'README.md'],
      approvedHash: 'e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

describe('run', () => {
  const baseDeps = () => ({
    log: vi.fn(),
    logError: vi.fn(),
    cwd: '/repo',
  });

  it('passes through silently when the branch is not a manifest-proposal branch', () => {
    const deps = baseDeps();
    const code = run({
      env: { BRANCH: 'gate/g1-remediation' },
      listChangedPaths: vi.fn(() => {
        throw new Error('must not be called for an ordinary branch');
      }),
      ...deps,
    });
    expect(code).toBe(0);
  });

  it('requires BASE_SHA/HEAD_SHA once a proposal branch is detected', () => {
    const deps = baseDeps();
    const code = run({
      env: { BRANCH: 'manifest-proposal/g2' },
      ...deps,
    });
    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringMatching(/BASE_SHA and HEAD_SHA/));
  });

  it('succeeds for a valid single-file, not-yet-adopted proposal', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-proposal/g2',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: JSON.stringify({}),
      },
      listChangedPaths: () => ['governance/gate-manifests/g2.yaml'],
      ...deps,
    });
    expect(code).toBe(0);
  });

  it('fails when the diff carries a second file alongside the manifest', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-proposal/g2',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: JSON.stringify({}),
      },
      listChangedPaths: () => [
        'governance/gate-manifests/g2.yaml',
        'scripts/verify/check-gate-scope.mjs',
      ],
      ...deps,
    });
    expect(code).toBe(1);
  });

  it('fails when the named gate already has an approved hash', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-proposal/g1',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: JSON.stringify({
          GATE_MANIFEST_APPROVED_HASH_G1:
            'e95bfcf5e97580d1e9f076de47f6da4e4b7e31bd5e57b162c5c4cdfdf43ed162',
        }),
      },
      listChangedPaths: () => ['governance/gate-manifests/g1.yaml'],
      ...deps,
    });
    expect(code).toBe(1);
  });

  it('fails closed on unparseable ALL_VARS rather than treating it as empty', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-proposal/g2',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: '{not json',
      },
      listChangedPaths: () => ['governance/gate-manifests/g2.yaml'],
      ...deps,
    });
    expect(code).toBe(1);
  });
});
