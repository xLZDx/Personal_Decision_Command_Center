import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TEST_EXTENSIONS,
  TEST_FILE,
  TEST_PATHSPECS,
  findProblems,
  parseNameStatusZ,
  run,
} from '../../scripts/verify/check-test-deletion.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `git diff --name-status -z` output, built from records, so the tests speak git's own format. */
function nameStatusZ(records) {
  return records.map((fields) => fields.join('\0')).join('\0') + '\0';
}

/**
 * These two are the regression tests that matter.
 *
 * The original guard was blind to `.test.mjs` in BOTH halves at once -- the file-status regex and
 * the skip-detection pathspec -- which left every governance suite in this repository deletable in
 * silence. A per-case unit test would not have caught it: each case would have been written with a
 * `.test.ts` fixture, passed, and proved nothing about the corpus the guard actually faces. So the
 * assertions below run against the real repository and against the real argument list handed to
 * git, not against fixtures chosen by the same person who wrote the rule.
 */
describe('the guard covers the corpus it is pointed at', () => {
  it('recognises every test file tracked in this repository', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter((p) => p !== '');

    // Deliberately a DIFFERENT rule from the one under test: anything whose filename contains
    // `.test.` is a test file as far as this assertion is concerned. If someone adds
    // `foo.test.svelte`, this fails loudly rather than leaving the guard quietly narrower than the
    // corpus -- which is the exact failure being regression-tested.
    const looksLikeTest = tracked.filter((p) => basename(p).includes('.test.'));

    expect(looksLikeTest.length).toBeGreaterThan(0);
    for (const path of looksLikeTest) {
      expect(TEST_FILE.test(path), `${path} is not seen by the test-deletion guard`).toBe(true);
    }
  });

  it('asks git for every extension the regex matches', () => {
    const calls = [];
    const exit = run({
      env: { BASE_SHA: 'base', HEAD_SHA: 'head' },
      runGit: (args) => {
        calls.push(args);
        return '';
      },
      log: () => {},
      error: () => {},
    });

    expect(exit).toBe(0);
    const diffCall = calls.find((args) => args.includes('-U0'));
    expect(diffCall).toBeDefined();

    // A named floor FIRST, before anything derived from the list under test. Iterating
    // TEST_EXTENSIONS alone would be vacuous: shrink that array back to `['ts']` -- the original
    // defect, exactly -- and a loop over it still passes, because it only ever asserts that the
    // guard is consistent with itself. Verified by running this suite against the reintroduced
    // defect: this case stayed green until these two lines were added, and now fails.
    expect(diffCall, 'skip detection is blind to .test.mjs -- the original defect').toContain(
      '*.test.mjs',
    );
    expect(diffCall, 'skip detection is blind to .test.ts').toContain('*.test.ts');

    // Then the drift check: the half that reads file status and the half that reads the diff must
    // see the same set of extensions. They are separate syntaxes, and the original defect was
    // precisely that they had drifted apart with nothing asserting they had not.
    for (const ext of TEST_EXTENSIONS) {
      expect(diffCall, `skip detection never looks at .test.${ext}`).toContain(`*.test.${ext}`);
    }
    expect(TEST_PATHSPECS).toHaveLength(TEST_EXTENSIONS.length);
  });
});

describe('deleted test files', () => {
  it('catches a deleted .test.mjs', () => {
    const { problems } = findProblems({
      nameStatus: nameStatusZ([['D', 'tests/policy/gate-scope.test.mjs']]),
      diff: '',
    });
    expect(problems).toEqual(['deleted test file: tests/policy/gate-scope.test.mjs']);
  });

  it('still catches a deleted .test.ts', () => {
    const { problems } = findProblems({
      nameStatus: nameStatusZ([['D', 'packages/contracts/tests/event.test.ts']]),
      diff: '',
    });
    expect(problems).toEqual(['deleted test file: packages/contracts/tests/event.test.ts']);
  });

  it('ignores a deleted file that is not a test', () => {
    const { problems, notes } = findProblems({
      nameStatus: nameStatusZ([['D', 'scripts/verify/check-test-deletion.mjs']]),
      diff: '',
    });
    expect(problems).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe('renames', () => {
  it('does not desync when a rename carries two path fields', () => {
    const records = parseNameStatusZ(
      nameStatusZ([
        ['R100', 'tests/policy/old.test.mjs', 'tests/policy/new.test.mjs'],
        ['D', 'tests/policy/codeowners.test.mjs'],
      ]),
    );

    expect(records).toEqual([
      {
        status: 'R100',
        source: 'tests/policy/old.test.mjs',
        path: 'tests/policy/new.test.mjs',
      },
      { status: 'D', path: 'tests/policy/codeowners.test.mjs' },
    ]);
  });

  it('notes a rename within the corpus without failing', () => {
    const { problems, notes } = findProblems({
      nameStatus: nameStatusZ([['R100', 'tests/policy/old.test.mjs', 'tests/policy/new.test.mjs']]),
      diff: '',
    });
    expect(problems).toEqual([]);
    expect(notes).toEqual(['test file renamed -> tests/policy/new.test.mjs']);
  });

  it('fails a rename that carries a file out of the test corpus', () => {
    const { problems } = findProblems({
      nameStatus: nameStatusZ([
        ['R100', 'tests/policy/gate-scope.test.mjs', 'tests/policy/gate-scope.mjs'],
      ]),
      diff: '',
    });
    expect(problems).toEqual([
      'test file renamed out of the test corpus: tests/policy/gate-scope.test.mjs -> tests/policy/gate-scope.mjs',
    ]);
  });
});

describe('newly skipped tests', () => {
  /**
   * Assembled at runtime, never written out as literals -- and that is a real constraint, not
   * fastidiousness.
   *
   * This file is itself a `.test.mjs`, so once the guard stopped being blind to that extension it
   * began scanning this file's own added lines. A fixture spelling `it` + `.skip` verbatim is
   * indistinguishable, to a line-based scanner, from a test someone actually skipped -- and CI
   * proved it: the first run of this PR failed with six "newly skipped test" reports, every one of
   * them a fixture from this block. That was the fix working, pointed at itself.
   *
   * The alternative was to teach the guard to ignore string literals, or to exempt this file. Both
   * put a hole in a guard whose entire value is having none, to save a test from an inconvenience.
   * So the inconvenience stays here.
   */
  const SKIP = '.skip';
  const TODO = '.todo';
  const skipLines = [
    `+  it${SKIP}('refuses an out-of-scope path', () => {`,
    `+  test${TODO}('rejects an unapproved hash');`,
    `+  describe${SKIP}('the floor', () => {`,
    `+  x${'it'}('still counts', () => {`,
    `+  x${'describe'}('the whole suite', () => {`,
  ];

  for (const line of skipLines) {
    it(`catches ${line.trim().slice(0, 24)}`, () => {
      const { problems } = findProblems({ nameStatus: '', diff: line });
      expect(problems).toEqual([`newly skipped test: ${line.trim()}`]);
    });
  }

  it('ignores a removed skip and the diff header', () => {
    const diff = [
      '--- a/tests/policy/gate-scope.test.mjs',
      '+++ b/tests/policy/gate-scope.test.mjs',
      `-  it${SKIP}('was skipped, now restored', () => {`,
    ].join('\n');
    const { problems } = findProblems({ nameStatus: '', diff });
    expect(problems).toEqual([]);
  });
});

/**
 * `-z` is tested against a REAL repository, not a stub, for the same reason `changedPathsFrom` is
 * in `gate-scope.test.mjs`. Dropping it breaks the check twice over, and both were measured rather
 * than reasoned about: the record parser is NUL-based, so without `-z` the whole output arrives as
 * one field and nothing is recognised at all; and git additionally quotes and backslash-escapes any
 * filename outside plain ASCII, so even a parser that coped would be matching an escaped form
 * against a pattern written in terms of the real name -- a `.test.mjs` whose name is not ASCII
 * would stop ending in `.mjs` as far as the regex is concerned.
 *
 * Added after the mutation harness reported "drop -z" as a SURVIVOR: every other mutation on this
 * file was killed, and that one was not, because the suite fed `findProblems` NUL-joined fixtures
 * and so never exercised the flag at the call site at all.
 */
describe('unusual filenames (real git repository)', () => {
  let repo;
  let base;
  let head;

  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'pdos-testdel-'));
    git(['init', '--quiet']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'test']);
    git(['config', 'core.quotepath', 'true']); // the default that mangles non-ASCII without -z
    git(['config', 'core.autocrlf', 'false']);

    writeFileSync(join(repo, 'документ.test.mjs'), "it('x', () => {});\n");
    writeFileSync(join(repo, 'has space.test.mjs'), "it('y', () => {});\n");
    writeFileSync(join(repo, 'keep.txt'), 'a\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'base']);
    base = git(['rev-parse', 'HEAD']);

    rmSync(join(repo, 'документ.test.mjs'));
    rmSync(join(repo, 'has space.test.mjs'));
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'delete both test files']);
    head = git(['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it('catches the deletion of a test file whose name is not ASCII', () => {
    const errors = [];
    const exit = run({
      env: { BASE_SHA: base, HEAD_SHA: head },
      cwd: repo,
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(exit).toBe(1);
    const reported = errors.join('\n');
    expect(reported).toContain('документ.test.mjs');
    // The failure being guarded against is a quoted/escaped form riding through as a literal path.
    expect(reported).not.toContain('\\320');
  });

  it('catches the deletion of a test file whose name contains a space', () => {
    const errors = [];
    const exit = run({
      env: { BASE_SHA: base, HEAD_SHA: head },
      cwd: repo,
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(exit).toBe(1);
    expect(errors.join('\n')).toContain('has space.test.mjs');
  });
});

describe('exit codes', () => {
  it('returns 1 when a problem is found', () => {
    const exit = run({
      env: { BASE_SHA: 'base', HEAD_SHA: 'head' },
      runGit: (args) =>
        args.includes('--name-status') ? nameStatusZ([['D', 'tests/policy/x.test.mjs']]) : '',
      log: () => {},
      error: () => {},
    });
    expect(exit).toBe(1);
  });

  it('returns 1 when the pull_request context is missing', () => {
    const exit = run({
      env: {},
      runGit: () => {
        throw new Error('git must not be reached without a range');
      },
      log: () => {},
      error: () => {},
    });
    expect(exit).toBe(1);
  });
});
