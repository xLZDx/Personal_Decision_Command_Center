import { describe, expect, it } from 'vitest';

import { ALLOWED_PATHS, FORBIDDEN_PATHS, run } from '../../scripts/verify/check-floor-scope.mjs';
import { checkScope } from '../../scripts/verify/check-gate-scope.mjs';

describe('the floor scope constants', () => {
  it('declares the deliberate allow-everything scope, and nothing else', () => {
    expect(ALLOWED_PATHS).toEqual(['**']);
  });

  it('forbids exactly the governance-authority paths an ungated PR must not touch', () => {
    expect(FORBIDDEN_PATHS).toEqual([
      'governance/gate-manifests/**',
      'governance/operator-approvals/**',
      'docs/architecture/TDD.md',
      '.github/workflows/**',
      '.github/CODEOWNERS',
    ]);
  });
});

describe('the floor scope, via checkScope', () => {
  it('forbids a per-gate manifest, so an ungated PR can never touch gate-scope authority', () => {
    const { violations } = checkScope({
      changedPaths: ['governance/gate-manifests/g1.yaml'],
      allowed: ALLOWED_PATHS,
      forbidden: FORBIDDEN_PATHS,
    });
    expect(violations).toEqual([
      { path: 'governance/gate-manifests/g1.yaml', pattern: 'governance/gate-manifests/**' },
    ]);
  });

  it('forbids the enforcement workflow itself', () => {
    const { violations } = checkScope({
      changedPaths: ['.github/workflows/governance.yml'],
      allowed: ALLOWED_PATHS,
      forbidden: FORBIDDEN_PATHS,
    });
    expect(violations).toEqual([
      { path: '.github/workflows/governance.yml', pattern: '.github/workflows/**' },
    ]);
  });

  it('forbids CODEOWNERS, the operator-approvals record, and the frozen TDD baseline', () => {
    const { violations } = checkScope({
      changedPaths: [
        '.github/CODEOWNERS',
        'governance/operator-approvals/2026-09-11.md',
        'docs/architecture/TDD.md',
      ],
      allowed: ALLOWED_PATHS,
      forbidden: FORBIDDEN_PATHS,
    });
    expect(violations).toEqual([
      { path: '.github/CODEOWNERS', pattern: '.github/CODEOWNERS' },
      {
        path: 'governance/operator-approvals/2026-09-11.md',
        pattern: 'governance/operator-approvals/**',
      },
      { path: 'docs/architecture/TDD.md', pattern: 'docs/architecture/TDD.md' },
    ]);
  });

  it('allows an ordinary evidence/docs path through the vacuous "**", warning surfaced', () => {
    const { violations, vacuous } = checkScope({
      changedPaths: ['scripts/probes/cloudflare-free-cpu/RESULTS.md', 'core/DECISION_LOG.md'],
      allowed: ALLOWED_PATHS,
      forbidden: FORBIDDEN_PATHS,
    });
    expect(violations).toEqual([]);
    expect(vacuous).toEqual(['**']);
  });
});

describe('run', () => {
  const ENV = { BASE_SHA: 'aaaa', HEAD_SHA: 'bbbb' };

  function invoke({ env = ENV, changed = [], listChangedPaths } = {}) {
    const out = [];
    const err = [];
    const code = run({
      env,
      cwd: '/repo',
      listChangedPaths: listChangedPaths ?? (() => changed),
      log: (m) => out.push(m),
      logError: (m) => err.push(m),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('exits 0 on an evidence-only diff', () => {
    const { code, out } = invoke({ changed: ['scripts/probes/cloudflare-free-cpu/RESULTS.md'] });
    expect(code).toBe(0);
    expect(out).toContain('within the ungated floor');
  });

  it('exits 1 on a diff that edits the enforcement workflow', () => {
    const { code, err } = invoke({ changed: ['.github/workflows/governance.yml'] });
    expect(code).toBe(1);
    expect(err).toContain('.github/workflows/governance.yml');
  });

  it('exits 1 on a diff that edits a gate manifest', () => {
    const { code, err } = invoke({ changed: ['governance/gate-manifests/g2.yaml'] });
    expect(code).toBe(1);
    expect(err).toContain('governance/gate-manifests/g2.yaml');
  });

  it('exits 1 when a required environment variable is missing', () => {
    for (const name of ['BASE_SHA', 'HEAD_SHA']) {
      const env = { ...ENV, [name]: '' };
      const { code, err } = invoke({ env, changed: ['README.md'] });
      expect(code, `${name} missing must fail`).toBe(1);
      expect(err).toContain(name);
    }
  });

  it('exits 1 when listing the changed paths fails, instead of reporting an empty diff', () => {
    const { code, err } = invoke({
      listChangedPaths: () => {
        throw new Error('not a git repository');
      },
    });
    expect(code).toBe(1);
    expect(err).toContain('could not list the changed paths');
  });

  it('warns, and still passes, because the floor is deliberately allow-everything', () => {
    const { code, out } = invoke({ changed: ['anything/at/all.ts'] });
    expect(code).toBe(0);
    expect(out).toContain('::warning::');
  });

  it('exits 0 on an empty diff', () => {
    expect(invoke({ changed: [] }).code).toBe(0);
  });
});
