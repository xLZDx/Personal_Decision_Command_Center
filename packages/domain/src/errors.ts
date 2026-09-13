/**
 * Real D1 and the test D1 shim (packages/testkit) both surface a UNIQUE-constraint violation as a
 * rejected promise whose error message carries SQLite's own text, not a typed error class. This is
 * the one place `ingest.ts`'s idempotent insert and `nonce.ts`'s replay check need to distinguish
 * "this exact row already exists" (an expected, idempotent outcome) from every other insert
 * failure (a real defect that must propagate).
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
