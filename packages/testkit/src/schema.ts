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
 * ingest/outbox/DLQ) with 0002 (Gmail connector), 0003 (OAuth disconnect lock, checkpoint 4
 * round-3), 0004 (OAuth lifecycle lock, checkpoint 4 round-8), 0005 (unique Gmail email,
 * checkpoint 4 round-9) and 0006 (history-sync resumable checkpoint, checkpoint 5 GPT-PM round-1)
 * so a G3 test gets every table G3's own tables reference via FK (source_accounts, ingest_events)
 * without re-declaring them.
 */
export function loadG3Schema(): string {
  const path0002 = fileURLToPath(
    new URL('../../../infra/migrations/0002_gmail_connector.sql', import.meta.url),
  );
  const path0003 = fileURLToPath(
    new URL('../../../infra/migrations/0003_gmail_oauth_disconnect_lock.sql', import.meta.url),
  );
  const path0004 = fileURLToPath(
    new URL('../../../infra/migrations/0004_gmail_oauth_lifecycle_lock.sql', import.meta.url),
  );
  const path0005 = fileURLToPath(
    new URL('../../../infra/migrations/0005_gmail_connections_unique_email.sql', import.meta.url),
  );
  const path0006 = fileURLToPath(
    new URL('../../../infra/migrations/0006_gmail_history_sync_progress.sql', import.meta.url),
  );
  return (
    `${loadG2Schema()}\n${readFileSync(path0002, 'utf8')}\n${readFileSync(path0003, 'utf8')}\n` +
    `${readFileSync(path0004, 'utf8')}\n${readFileSync(path0005, 'utf8')}\n` +
    `${readFileSync(path0006, 'utf8')}`
  );
}
