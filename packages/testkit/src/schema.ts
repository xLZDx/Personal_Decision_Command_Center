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

/**
 * G3's schema builds on G2's unchanged -- concatenates migration 0001 (accounts/policy/cursor/
 * ingest/outbox/DLQ) with 0002 (Gmail connector) and 0003 (OAuth disconnect lock, checkpoint 4
 * round-3) so a G3 test gets every table G3's own tables reference via FK (source_accounts,
 * ingest_events) without re-declaring them.
 */
export function loadG3Schema(): string {
  const path0002 = fileURLToPath(
    new URL('../../../infra/migrations/0002_gmail_connector.sql', import.meta.url),
  );
  const path0003 = fileURLToPath(
    new URL('../../../infra/migrations/0003_gmail_oauth_disconnect_lock.sql', import.meta.url),
  );
  return `${loadG2Schema()}\n${readFileSync(path0002, 'utf8')}\n${readFileSync(path0003, 'utf8')}`;
}
