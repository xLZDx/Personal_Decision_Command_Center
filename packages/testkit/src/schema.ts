/* global URL */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for "which schema file do G2 tests run against" -- every domain/service
 * test asks this instead of hardcoding a relative path to `infra/migrations/0001_ingest_outbox.sql`,
 * so the path is correct in exactly one place if the migrations directory ever changes.
 */
export function loadG2Schema(): string {
  const path = fileURLToPath(
    new URL('../../../infra/migrations/0001_ingest_outbox.sql', import.meta.url),
  );
  return readFileSync(path, 'utf8');
}
