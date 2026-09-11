import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  changedPathsFrom,
  checkScope,
  compilePattern,
  matches,
  parsePathList,
  run,
} from '../../scripts/verify/check-gate-scope.mjs';

describe('compilePattern', () => {
  it('matches a literal path exactly and nothing around it', () => {
    expect(matches('core/DECISION_LOG.md', 'core/DECISION_LOG.md')).toBe(true);
    expect(matches('core/DECISION_LOG.md.bak', 'core/DECISION_LOG.md')).toBe(false);
    expect(matches('x/core/DECISION_LOG.md', 'core/DECISION_LOG.md')).toBe(false);
  });

  it('treats "." as a literal, not as a regex wildcard', () => {
    // Each of these differs from the pattern ONLY at the ".", so an unescaped dot is the only
    // thing that could make them match.
    expect(matches('core/DECISION_LOGxmd', 'core/DECISION_LOG.md')).toBe(false);
    expect(matches('docs/aXmd', 'docs/*.md')).toBe(false);
  });

  it('does not let a single "*" cross a path separator', () => {
    expect(matches('packages/contracts.ts', 'packages/*')).toBe(true);
    expect(matches('packages/contracts/src/event.ts', 'packages/*')).toBe(false);
  });

  it('lets a trailing "**" cross separators but not match the bare directory', () => {
    expect(matches('packages/contracts/src/event.ts', 'packages/**')).toBe(true);
    expect(matches('packages/a.ts', 'packages/**')).toBe(true);
    expect(matches('packages', 'packages/**')).toBe(false);
    expect(matches('otherpackages/a.ts', 'packages/**')).toBe(false);
  });

  it('lets an interior "**" match zero segments as well as many', () => {
    expect(matches('docs/notes.md', 'docs/**/notes.md')).toBe(true);
    expect(matches('docs/a/b/notes.md', 'docs/**/notes.md')).toBe(true);
    expect(matches('docs/a/b/other.md', 'docs/**/notes.md')).toBe(false);
  });

  it('anchors at both ends', () => {
    expect(matches('adocs/x.md', 'docs/*.md')).toBe(false);
    expect(matches('docs/x.md.old', 'docs/*.md')).toBe(false);
  });

  it('rejects patterns whose meaning would be ambiguous or unsafe', () => {
    expect(() => compilePattern('')).toThrow(/empty pattern/);
    expect(() => compilePattern('/packages/**')).toThrow(/must not start/);
    expect(() => compilePattern('packages\\**')).toThrow(/separator/);
    expect(() => compilePattern('packages//a')).toThrow(/empty path segment/);
    expect(() => compilePattern('docs/../core/a.md')).toThrow(/not accepted/);
    expect(() => compilePattern('packages/a**b')).toThrow(/whole segment/);
  });
});

describe('checkScope', () => {
  const allowed = ['packages/contracts/**', 'core/DECISION_LOG.md'];

  it('accepts a diff entirely inside the approved scope', () => {
    const { violations, vacuous } = checkScope({
      changedPaths: ['packages/contracts/src/event.ts', 'core/DECISION_LOG.md'],
      allowed,
    });
    expect(violations).toEqual([]);
    expect(vacuous).toEqual([]);
  });

  it('reports a path that no allowed pattern covers', () => {
    const { violations } = checkScope({
      changedPaths: ['services/processor/src/index.ts'],
      allowed,
    });
    expect(violations).toEqual([{ path: 'services/processor/src/index.ts', pattern: null }]);
  });

  it('lets forbidden_paths override an otherwise allowed path', () => {
    const { violations } = checkScope({
      changedPaths: ['packages/contracts/src/secrets.ts'],
      allowed,
      forbidden: ['**/secrets.ts'],
    });
    expect(violations).toEqual([
      { path: 'packages/contracts/src/secrets.ts', pattern: '**/secrets.ts' },
    ]);
  });

  it('refuses to evaluate a scope that authorizes nothing rather than passing vacuously', () => {
    expect(() => checkScope({ changedPaths: ['a.ts'], allowed: [] })).toThrow(/missing or empty/);
    expect(() => checkScope({ changedPaths: ['a.ts'], allowed: undefined })).toThrow(
      /missing or empty/,
    );
  });

  it('flags an allow-everything entry, which makes the check unable to refuse anything', () => {
    const { violations, vacuous } = checkScope({
      changedPaths: ['anything/at/all.ts'],
      allowed: ['**'],
    });
    expect(violations).toEqual([]);
    expect(vacuous).toEqual(['**']);
  });
});

describe('parsePathList', () => {
  const manifest = [
    'plan_id: pdos-g1-remediation-2026-09-10',
    'allowed_paths:',
    '  # the contracts package',
    '  - packages/contracts/**',
    '',
    '  - core/DECISION_LOG.md  # decision log is always in scope',
    '  - "*.md"',
    'forbidden_paths:',
    '  - governance/gate-manifests/**',
    'required_tests:',
    '  - npm run verify',
  ].join('\n');

  it('reads a block sequence, skipping blank lines and comments', () => {
    expect(parsePathList(manifest, 'allowed_paths')).toEqual([
      'packages/contracts/**',
      'core/DECISION_LOG.md',
      '*.md',
    ]);
  });

  it('stops at the next top-level key instead of swallowing the rest of the file', () => {
    expect(parsePathList(manifest, 'forbidden_paths')).toEqual(['governance/gate-manifests/**']);
  });

  it('returns null for an absent key so the caller decides whether that is fatal', () => {
    expect(parsePathList(manifest, 'policy_sensitive_files')).toBeNull();
  });

  it('rejects a duplicated key rather than silently honouring one of them', () => {
    const doubled = 'allowed_paths:\n  - a/**\nallowed_paths:\n  - "**"\n';
    expect(() => parsePathList(doubled, 'allowed_paths')).toThrow(/appears 2 times/);
  });

  it('rejects flow style, which a block-sequence reader would otherwise read as empty', () => {
    expect(() => parsePathList('allowed_paths: [a/**, b/**]\n', 'allowed_paths')).toThrow(
      /block sequence/,
    );
  });

  it('rejects a nested mapping under the key instead of returning an empty list', () => {
    expect(() => parsePathList('allowed_paths:\n  packages: true\n', 'allowed_paths')).toThrow(
      /Unsupported line/,
    );
  });

  it('rejects an unquoted leading "*", which YAML reads as an alias', () => {
    expect(() => parsePathList('allowed_paths:\n  - *.md\n', 'allowed_paths')).toThrow(
      /alias or anchor/,
    );
  });

  it('rejects an unquoted leading "&", the other half of the alias/anchor check', () => {
    // Split out deliberately: while this and the "*" case shared one `||` condition, a change
    // that dropped only the "&" branch passed every test.
    expect(() => parsePathList('allowed_paths:\n  - &anchor\n', 'allowed_paths')).toThrow(
      /alias or anchor/,
    );
  });

  it('rejects a block scalar', () => {
    expect(() => parsePathList('allowed_paths:\n  - |\n', 'allowed_paths')).toThrow(
      /block scalars/,
    );
    expect(() => parsePathList('allowed_paths:\n  - >\n', 'allowed_paths')).toThrow(
      /block scalars/,
    );
  });

  it('rejects an empty entry', () => {
    expect(() => parsePathList('allowed_paths:\n  - ""\n', 'allowed_paths')).toThrow(
      /empty pattern/,
    );
  });

  // The two cases below are the internal security review's finding. Before it, ANY non-indented
  // line ended the block, so a list item that lost its indent produced an empty list with no
  // error -- and for `forbidden_paths` an empty list is exactly what "nothing is forbidden"
  // looks like, so the manifest read correctly to a human while enforcing nothing.
  it('rejects an unindented list item instead of silently truncating the list', () => {
    const slipped = ['allowed_paths:', '  - src/**', 'forbidden_paths:', '- secrets/**', ''].join(
      '\n',
    );
    expect(() => parsePathList(slipped, 'forbidden_paths')).toThrow(/must be indented/);
  });

  it('rejects a key that is present but declares no entries', () => {
    const empty = ['allowed_paths:', '  - src/**', 'forbidden_paths:', 'required_tests:', ''].join(
      '\n',
    );
    expect(() => parsePathList(empty, 'forbidden_paths')).toThrow(/no entries/);
  });

  it('still ends the block at a genuine next top-level key', () => {
    // The control for the two tests above: the strictness must not break normal manifests.
    expect(parsePathList(manifest, 'allowed_paths')).toHaveLength(3);
    expect(parsePathList(manifest, 'forbidden_paths')).toEqual(['governance/gate-manifests/**']);
  });
});

// `run` is the only part of this file CI actually executes, and its exit code IS the guarantee
// the whole control provides. Everything below asserts the exit code, not the log text.
describe('run', () => {
  const MANIFEST = [
    'allowed_paths:',
    '  - packages/contracts/**',
    'forbidden_paths:',
    '  - packages/contracts/src/secrets.ts',
    '',
  ].join('\n');

  const ENV = {
    GATE: 'G1',
    MANIFEST: 'governance/gate-manifests/g1.yaml',
    BASE_SHA: 'aaaa',
    HEAD_SHA: 'bbbb',
  };

  function invoke({ env = ENV, manifest = MANIFEST, changed = [], readFile } = {}) {
    const out = [];
    const err = [];
    const code = run({
      env,
      cwd: '/repo',
      readFile: readFile ?? (() => manifest),
      listChangedPaths: () => changed,
      log: (m) => out.push(m),
      logError: (m) => err.push(m),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('exits 0 when every changed path is in scope', () => {
    const { code, out } = invoke({ changed: ['packages/contracts/src/event.ts'] });
    expect(code).toBe(0);
    expect(out).toContain("within G1's approved scope");
  });

  it('exits 1 on a path outside the approved scope', () => {
    const { code, err } = invoke({ changed: ['services/processor/src/index.ts'] });
    expect(code).toBe(1);
    expect(err).toContain('services/processor/src/index.ts');
  });

  it('exits 1 on a forbidden path even though allowed_paths would cover it', () => {
    const { code, err } = invoke({ changed: ['packages/contracts/src/secrets.ts'] });
    expect(code).toBe(1);
    expect(err).toContain('forbidden');
  });

  it('exits 1 when a required environment variable is missing', () => {
    for (const name of ['GATE', 'MANIFEST', 'BASE_SHA', 'HEAD_SHA']) {
      const env = { ...ENV, [name]: '' };
      const { code, err } = invoke({ env, changed: ['packages/contracts/src/event.ts'] });
      expect(code, `${name} missing must fail`).toBe(1);
      expect(err).toContain(name);
    }
  });

  it('exits 1 when the manifest cannot be read from disk', () => {
    const { code, err } = invoke({
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(code).toBe(1);
    expect(err).toContain('could not be read');
  });

  it('exits 1 when the manifest declares no allowed_paths', () => {
    const { code, err } = invoke({ manifest: 'plan_id: x\n' });
    expect(code).toBe(1);
    expect(err).toContain('no allowed_paths');
  });

  it('exits 1 when the manifest is malformed rather than treating it as empty scope', () => {
    const { code } = invoke({ manifest: 'allowed_paths:\n- src/**\n' });
    expect(code).toBe(1);
  });

  it('exits 1 when listing the changed paths fails, instead of reporting an empty diff', () => {
    const err = [];
    const code = run({
      env: ENV,
      cwd: '/repo',
      readFile: () => MANIFEST,
      listChangedPaths: () => {
        throw new Error('not a git repository');
      },
      log: () => {},
      logError: (m) => err.push(m),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('could not list the changed paths');
  });

  it('warns, and still passes, on an allow-everything manifest', () => {
    const { code, out } = invoke({
      manifest: 'allowed_paths:\n  - "**"\n',
      changed: ['anything/at/all.ts'],
    });
    expect(code).toBe(0);
    expect(out).toContain('::warning::');
  });

  it('exits 0 on an empty diff', () => {
    expect(invoke({ changed: [] }).code).toBe(0);
  });
});

// changedPathsFrom exists to survive filenames the previous shell version mangled, so it is
// tested against a real git repository rather than a stub.
describe('changedPathsFrom', () => {
  let repo;
  let base;
  let head;

  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'pdos-scope-'));
    git(['init', '--quiet']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'test']);
    git(['config', 'core.quotepath', 'true']); // the default that mangles non-ASCII without -z
    git(['config', 'core.autocrlf', 'false']);

    writeFileSync(join(repo, 'first.txt'), 'a\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'base']);
    base = git(['rev-parse', 'HEAD']);

    writeFileSync(join(repo, 'has space.txt'), 'b\n');
    writeFileSync(join(repo, 'документ.md'), 'c\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'head']);
    head = git(['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('returns the real path of a file whose name contains a space', () => {
    expect(changedPathsFrom(base, head, repo)).toContain('has space.txt');
  });

  it('returns a non-ASCII filename unquoted and unescaped', () => {
    const paths = changedPathsFrom(base, head, repo);
    expect(paths).toContain('документ.md');
    // The failure this guards against is a quoted/escaped form riding through as a literal path,
    // which would then be matched against patterns written in terms of the real name.
    expect(paths.some((p) => p.includes('\\') || p.startsWith('"'))).toBe(false);
  });

  it('returns no empty entries', () => {
    expect(changedPathsFrom(base, head, repo).every((p) => p !== '')).toBe(true);
  });

  it('returns an empty list when nothing changed between two identical trees', () => {
    expect(changedPathsFrom(head, head, repo)).toEqual([]);
  });
});
