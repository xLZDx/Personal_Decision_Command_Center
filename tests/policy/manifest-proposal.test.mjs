import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import {
  detectManifestBranch,
  run,
  validateManifestChange,
} from '../../scripts/verify/check-manifest-proposal.mjs';

const CANDIDATE_BYTES = Buffer.from('gate: G2\nallowed_paths:\n  - README.md\n');
const CANDIDATE_HASH = createHash('sha256').update(CANDIDATE_BYTES).digest('hex');
const OTHER_HASH = createHash('sha256').update('something else').digest('hex');

describe('detectManifestBranch', () => {
  it('recognizes manifest-proposal/g<N>, case-insensitive on the gate letter', () => {
    expect(detectManifestBranch('manifest-proposal/g2')).toEqual({
      isManifestBranch: true,
      kind: 'proposal',
      gate: 'G2',
    });
    expect(detectManifestBranch('manifest-proposal/G10')).toEqual({
      isManifestBranch: true,
      kind: 'proposal',
      gate: 'G10',
    });
  });

  it('recognizes manifest-amendment/g<N>, case-insensitive on the gate letter', () => {
    expect(detectManifestBranch('manifest-amendment/g1')).toEqual({
      isManifestBranch: true,
      kind: 'amendment',
      gate: 'G1',
    });
  });

  it('never matches ordinary gate/g<N>-... branches', () => {
    expect(detectManifestBranch('gate/g1-remediation').isManifestBranch).toBe(false);
    expect(detectManifestBranch('gate/g2-manifest-proposal').isManifestBranch).toBe(false);
  });

  it('rejects anything not an exact manifest-proposal/g<N> or manifest-amendment/g<N> match', () => {
    expect(detectManifestBranch('manifest-proposal/g2-extra').isManifestBranch).toBe(false);
    expect(detectManifestBranch('manifest-amendment/g2-extra').isManifestBranch).toBe(false);
    expect(detectManifestBranch('manifest-proposal/').isManifestBranch).toBe(false);
    expect(detectManifestBranch('manifest-proposal/g').isManifestBranch).toBe(false);
    expect(detectManifestBranch('manifest-amendment/').isManifestBranch).toBe(false);
    expect(detectManifestBranch('manifest-amendment/g').isManifestBranch).toBe(false);
    expect(detectManifestBranch('').isManifestBranch).toBe(false);
    expect(detectManifestBranch(undefined).isManifestBranch).toBe(false);
  });
});

describe('validateManifestChange', () => {
  it('accepts exactly one manifest file whose hash matches the operator-approved value', () => {
    const result = validateManifestChange({
      kind: 'proposal',
      gate: 'G2',
      changedPaths: ['governance/gate-manifests/g2.yaml'],
      approvedHash: CANDIDATE_HASH,
      candidateHash: CANDIDATE_HASH,
    });
    expect(result).toEqual({
      valid: true,
      errors: [],
      expectedPath: 'governance/gate-manifests/g2.yaml',
    });
  });

  it('rejects more than one changed file, even if the manifest is among them', () => {
    const result = validateManifestChange({
      kind: 'proposal',
      gate: 'G2',
      changedPaths: ['governance/gate-manifests/g2.yaml', '.github/workflows/governance.yml'],
      approvedHash: undefined,
      candidateHash: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/exactly one file/);
  });

  it('rejects a lone changed file that is not the expected manifest path', () => {
    const result = validateManifestChange({
      kind: 'proposal',
      gate: 'G2',
      changedPaths: ['governance/gate-manifests/g3.yaml'],
      approvedHash: undefined,
      candidateHash: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must change governance\/gate-manifests\/g2\.yaml/);
  });

  it('rejects when no approved hash is set yet, even for the right single file', () => {
    const result = validateManifestChange({
      kind: 'proposal',
      gate: 'G2',
      changedPaths: ['governance/gate-manifests/g2.yaml'],
      approvedHash: undefined,
      candidateHash: CANDIDATE_HASH,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/is not set/);
    expect(result.errors[0]).toContain(CANDIDATE_HASH);
  });

  it('rejects when the approved hash does not match the candidate bytes', () => {
    const result = validateManifestChange({
      kind: 'amendment',
      gate: 'G1',
      changedPaths: ['governance/gate-manifests/g1.yaml'],
      approvedHash: OTHER_HASH,
      candidateHash: CANDIDATE_HASH,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/does not match/);
  });

  it('accepts an amendment to an already-adopted gate when the new hash was pre-approved', () => {
    const result = validateManifestChange({
      kind: 'amendment',
      gate: 'G1',
      changedPaths: ['governance/gate-manifests/g1.yaml'],
      approvedHash: CANDIDATE_HASH,
      candidateHash: CANDIDATE_HASH,
    });
    expect(result.valid).toBe(true);
  });

  it('does not also complain about the hash when candidateHash is null (wrong file/count already failed)', () => {
    const result = validateManifestChange({
      kind: 'proposal',
      gate: 'G2',
      changedPaths: ['governance/gate-manifests/g3.yaml'],
      approvedHash: undefined,
      candidateHash: null,
    });
    expect(result.errors).toHaveLength(1);
  });
});

describe('run', () => {
  const baseDeps = () => ({
    log: vi.fn(),
    logError: vi.fn(),
    cwd: '/repo',
  });

  it('passes through silently when the branch is not a manifest-proposal/amendment branch', () => {
    const deps = baseDeps();
    const code = run({
      env: { BRANCH: 'gate/g1-remediation' },
      listChangedPaths: vi.fn(() => {
        throw new Error('must not be called for an ordinary branch');
      }),
      readManifestBytes: vi.fn(() => {
        throw new Error('must not be called for an ordinary branch');
      }),
      ...deps,
    });
    expect(code).toBe(0);
  });

  it('requires BASE_SHA/HEAD_SHA once a manifest branch is detected', () => {
    const deps = baseDeps();
    const code = run({
      env: { BRANCH: 'manifest-proposal/g2' },
      ...deps,
    });
    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringMatching(/BASE_SHA and HEAD_SHA/));
  });

  it('succeeds for a valid single-file proposal whose hash matches a pre-approved value', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-proposal/g2',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: JSON.stringify({ GATE_MANIFEST_APPROVED_HASH_G2: CANDIDATE_HASH }),
      },
      listChangedPaths: () => ['governance/gate-manifests/g2.yaml'],
      readManifestBytes: () => CANDIDATE_BYTES,
      ...deps,
    });
    expect(code).toBe(0);
  });

  it('succeeds for a valid single-file amendment whose new hash matches a pre-approved value', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-amendment/g1',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: JSON.stringify({ GATE_MANIFEST_APPROVED_HASH_G1: CANDIDATE_HASH }),
      },
      listChangedPaths: () => ['governance/gate-manifests/g1.yaml'],
      readManifestBytes: () => CANDIDATE_BYTES,
      ...deps,
    });
    expect(code).toBe(0);
  });

  it('fails when no approved hash is set at all (the corrected bootstrap requirement)', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-proposal/g2',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: JSON.stringify({}),
      },
      listChangedPaths: () => ['governance/gate-manifests/g2.yaml'],
      readManifestBytes: () => CANDIDATE_BYTES,
      ...deps,
    });
    expect(code).toBe(1);
  });

  it('fails when the approved hash exists but does not match the candidate bytes', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-proposal/g2',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: JSON.stringify({ GATE_MANIFEST_APPROVED_HASH_G2: OTHER_HASH }),
      },
      listChangedPaths: () => ['governance/gate-manifests/g2.yaml'],
      readManifestBytes: () => CANDIDATE_BYTES,
      ...deps,
    });
    expect(code).toBe(1);
  });

  it('fails when the diff carries a second file alongside the manifest, without reading its bytes', () => {
    const deps = baseDeps();
    const readManifestBytes = vi.fn();
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
      readManifestBytes,
      ...deps,
    });
    expect(code).toBe(1);
    expect(readManifestBytes).not.toHaveBeenCalled();
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
      readManifestBytes: () => CANDIDATE_BYTES,
      ...deps,
    });
    expect(code).toBe(1);
  });

  it('fails closed when the manifest file cannot be read to compute its hash', () => {
    const deps = baseDeps();
    const code = run({
      env: {
        BRANCH: 'manifest-proposal/g2',
        BASE_SHA: 'aaa',
        HEAD_SHA: 'bbb',
        ALL_VARS: JSON.stringify({}),
      },
      listChangedPaths: () => ['governance/gate-manifests/g2.yaml'],
      readManifestBytes: () => {
        throw new Error('ENOENT');
      },
      ...deps,
    });
    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringMatching(/could not read/));
  });
});
