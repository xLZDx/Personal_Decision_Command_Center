import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Paths whose contents can change what is BINDING on this project: what a gate may touch, what a
 * check does, what the architecture says, what the operating contract requires.
 *
 * CODEOWNERS is the only control that actually enforces the governance invariant (merge authority;
 * CI is detection). A path that can redefine the rules and is not on this list can be changed by an
 * implementer branch with no operator review at all.
 *
 * This assertion exists because that happened twice in one gate: `scripts/verify/` held a
 * governance check while only `.github/` was protected, and `docs/architecture/TDD_ERRATA.md` was
 * created as a NORMATIVE document that outranks the TDD -- and left unprotected -- in the very
 * change that was tightening the boundary. GPT-PM caught the second one.
 *
 * Adding a path here is cheap. Removing one should be loud, which is the point.
 */
const OPERATOR_OWNED = [
  ['/governance/gate-manifests/', 'a manifest defines what its gate is allowed to touch'],
  ['/governance/operator-approvals/', 'the approval records themselves'],
  ['/.github/', 'CI cannot police its own definition'],
  ['/scripts/verify/', 'the governance checks the workflow runs'],
  ['/core/SOURCE_POLICY.md', 'policy-sensitive (TDD 57(13))'],
  ['/core/DATA_RETENTION_POLICY.md', 'policy-sensitive (TDD 57(13))'],
  ['/core/adr/', 'adopted architecture decisions'],
  ['/docs/architecture/', 'the frozen TDD and the normative errata that outranks it'],
  ['/CLAUDE.md', 'the operating contract'],
  ['/AGENTS.md', 'the operating contract, tool-agnostic twin'],
];

/** Entries only, ignoring comments -- a path named in a comment protects nothing. */
function parseCodeowners(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return { pattern, owners };
    });
}

const codeowners = readFileSync(join(REPO, '.github', 'CODEOWNERS'), 'utf8');
const entries = parseCodeowners(codeowners);

describe('CODEOWNERS covers every path that can change what is binding', () => {
  for (const [path, why] of OPERATOR_OWNED) {
    it(`protects ${path} — ${why}`, () => {
      const entry = entries.find((e) => e.pattern === path);
      expect(entry, `${path} is not a CODEOWNERS entry`).toBeDefined();
      expect(entry.owners.length, `${path} has no owner`).toBeGreaterThan(0);
    });
  }

  it('gives every entry at least one owner', () => {
    const ownerless = entries.filter((e) => e.owners.length === 0).map((e) => e.pattern);
    expect(ownerless).toEqual([]);
  });

  it('does not count a path that appears only inside a comment', () => {
    // The control for the assertions above. A substring search over the file would "find"
    // /core/adr/ here and report the path as protected when it is commented out.
    const fixture = [
      '# /core/adr/                      @someone',
      '/other/            @someone',
    ].join('\n');
    const parsed = parseCodeowners(fixture);
    expect(parsed.map((e) => e.pattern)).toEqual(['/other/']);
  });
});
