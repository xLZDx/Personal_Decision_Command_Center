/* global URL */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for "which schema file do G2 tests run against" -- every domain/service
 * test asks this instead of hardcoding a relative path to `infra/migrations/0001_ingest_outbox.sql`,
 * so the path is correct in exactly one place if the migrations directory ever changes.
 *
 * Includes migration 0007 (`ingest_events.occurred_at_quality`, G3 checkpoint 5 GPT-PM round-2)
 * even though it was added during G3 work -- `ingest_events` is a G2-scope table (ADR-006), and
 * every G2 test needs the column NormalizedEvent's own contract now always carries.
 */
export function loadG2Schema(): string {
  const path0001 = fileURLToPath(
    new URL('../../../infra/migrations/0001_ingest_outbox.sql', import.meta.url),
  );
  const path0007 = fileURLToPath(
    new URL(
      '../../../infra/migrations/0007_ingest_events_occurred_at_quality.sql',
      import.meta.url,
    ),
  );
  return `${readFileSync(path0001, 'utf8')}\n${readFileSync(path0007, 'utf8')}`;
}

/**
 * G3's schema builds on G2's unchanged -- concatenates migration 0001+0007 (accounts/policy/
 * cursor/ingest/outbox/DLQ, via `loadG2Schema()`) with 0002 (Gmail connector), 0003 (OAuth
 * disconnect lock, checkpoint 4 round-3), 0004 (OAuth lifecycle lock, checkpoint 4 round-8), 0005
 * (unique Gmail email, checkpoint 4 round-9), 0006 (history-sync resumable checkpoint, checkpoint
 * 5 GPT-PM round-1), 0008 (history-sync checkpoint rebuild -- change-granularity budget + unified
 * MAIN/RECOVERY mode, checkpoint 5 GPT-PM round-2), 0009 (gmail_api_budget_counters upper-bound
 * CHECK, checkpoint 6 internal review) and 0010 (gmail_ai_neuron_budget raw-accounting rebuild +
 * gmail_ai_neuron_reservations ledger, checkpoint 6 GPT-PM round-1) so a G3 test gets every table
 * G3's own tables reference via FK (source_accounts, ingest_events) without re-declaring them.
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
  const path0008 = fileURLToPath(
    new URL(
      '../../../infra/migrations/0008_gmail_history_sync_progress_rebuild.sql',
      import.meta.url,
    ),
  );
  const path0009 = fileURLToPath(
    new URL(
      '../../../infra/migrations/0009_gmail_api_budget_counters_ceiling_check.sql',
      import.meta.url,
    ),
  );
  const path0010 = fileURLToPath(
    new URL(
      '../../../infra/migrations/0010_gmail_ai_neuron_reservation_ledger.sql',
      import.meta.url,
    ),
  );
  return (
    `${loadG2Schema()}\n${readFileSync(path0002, 'utf8')}\n${readFileSync(path0003, 'utf8')}\n` +
    `${readFileSync(path0004, 'utf8')}\n${readFileSync(path0005, 'utf8')}\n` +
    `${readFileSync(path0006, 'utf8')}\n${readFileSync(path0008, 'utf8')}\n` +
    `${readFileSync(path0009, 'utf8')}\n${readFileSync(path0010, 'utf8')}`
  );
}

/** Canonical local schema for MVP1 integration tests, matching staging migration order 0001–0015. */
export function loadMvp1Schema(): string {
  const files = [
    '0001_ingest_outbox.sql',
    '0002_gmail_connector.sql',
    '0003_gmail_oauth_disconnect_lock.sql',
    '0004_gmail_oauth_lifecycle_lock.sql',
    '0005_gmail_connections_unique_email.sql',
    '0006_gmail_history_sync_progress.sql',
    '0007_ingest_events_occurred_at_quality.sql',
    '0008_gmail_history_sync_progress_rebuild.sql',
    '0009_gmail_api_budget_counters_ceiling_check.sql',
    '0010_gmail_ai_neuron_reservation_ledger.sql',
    '0011_resolver_state.sql',
    '0012_g6_state_and_telegram_replay.sql',
    '0013_g5_core_entities.sql',
    '0014_g5_integrity_triggers.sql',
    '0015_g6_integrity_triggers.sql',
  ];
  return files
    .map((file) => readFileSync(fileURLToPath(new URL(`../../../infra/migrations/${file}`, import.meta.url)), 'utf8'))
    .join('\n');
}
