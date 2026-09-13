import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { idempotencyKey, type NormalizedEvent } from '@pdos/contracts';

import { isUniqueConstraintError } from './errors.js';

export type IngestOutcome =
  { status: 'ACCEPTED'; eventId: string } | { status: 'ALREADY_ACCEPTED'; eventId: string };

/**
 * Idempotently persists a validated `NormalizedEvent`: the event row, its routing hints and their
 * provenance edges, and a fresh outbox row -- all in one D1 `batch()` transaction (INV-14/TDD §14).
 *
 * Idempotency is enforced by the database, not by a pre-check: `ingest_events.idempotency_key` has
 * a UNIQUE index (migration 0001), so a duplicate submission's INSERT collides there and the whole
 * batch rolls back (including any routing-hint rows this call would otherwise have inserted for a
 * DIFFERENT, brand-new event_id -- this function is called once per distinct incoming submission,
 * so a collision always means "this exact logical event was already accepted"). The caller
 * (services/ingest's fetch handler) gets a normal ALREADY_ACCEPTED outcome back, never an error, so
 * a connector's at-least-once retry is a safe no-op rather than a 500.
 */
export async function ingestEvent(db: D1Database, event: NormalizedEvent): Promise<IngestOutcome> {
  const key = idempotencyKey(event);

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO ingest_events
          (event_id, source, source_account_id, source_event_id, source_thread_id, event_type,
           direction, occurred_at, received_at, content_locator_ref, source_policy_id, trace_id,
           schema_version, source_version, idempotency_key, state,
           processing_attempt_count, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ACCEPTED',0,?)`,
      )
      .bind(
        event.event_id,
        event.source,
        event.source_account_id,
        event.source_event_id,
        event.source_thread_id,
        event.event_type,
        event.direction,
        event.occurred_at,
        event.received_at,
        event.content_locator.ref,
        event.source_policy_id,
        event.trace_id,
        event.schema_version,
        event.source_version,
        key,
        event.received_at,
      ),
  ];

  event.routing_hints.forEach((hint, hintIndex) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO ingest_event_routing_hints
            (event_id, hint_index, value, derivation_method, ai_policy, sensitivity, created_at,
             derivation_version)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(
          event.event_id,
          hintIndex,
          hint.value,
          hint.derivation_method,
          hint.ai_policy,
          hint.sensitivity,
          hint.created_at,
          hint.derivation_version,
        ),
    );
    for (const provenanceEventId of hint.provenance) {
      statements.push(
        db
          .prepare(
            `INSERT INTO ingest_event_routing_hint_provenance
              (event_id, hint_index, provenance_event_id)
             VALUES (?,?,?)`,
          )
          .bind(event.event_id, hintIndex, provenanceEventId),
      );
    }
  });

  statements.push(
    db
      .prepare(
        `INSERT INTO processing_outbox (event_id, state, dispatch_count, next_attempt_at, updated_at)
         VALUES (?, 'PENDING', 0, ?, ?)`,
      )
      .bind(event.event_id, event.received_at, event.received_at),
  );

  try {
    await db.batch(statements);
    return { status: 'ACCEPTED', eventId: event.event_id };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const existing = await db
      .prepare('SELECT event_id FROM ingest_events WHERE idempotency_key = ?')
      .bind(key)
      .first<{ event_id: string }>();
    if (!existing) throw error;
    return { status: 'ALREADY_ACCEPTED', eventId: existing.event_id };
  }
}
