/**
 * G3 Workers AI policy checkpoint.
 *
 * The callable model alias and pricing-table model label do not currently match exactly:
 * Cloudflare documents `@cf/meta/llama-3.1-8b-instruct-fast` as the callable JSON-mode model,
 * while the lower fast rate is listed under an `...-fp8-fast` label. HARD_ZERO therefore does not
 * assume that those names are billing aliases. It reserves with the more expensive published
 * non-fast Llama 3.1 8B rates. See WORKERS_AI_MODEL_TERMS.md.
 */

export const WORKERS_AI_MODEL_ID = '@cf/meta/llama-3.1-8b-instruct-fast' as const;

/** Includes system instructions, schema, and minimized Gmail evidence after serialization. */
export const WORKERS_AI_MAX_REQUEST_UTF8_BYTES = 16_000;
export const WORKERS_AI_MAX_OUTPUT_TOKENS = 256;

/**
 * A Llama tokenizer consumes non-empty UTF-8 byte sequences, so request UTF-8 bytes are a safe
 * upper bound for content tokens. Chat-template and special tokens are not present in the request
 * bytes; this deliberately large allowance covers those provider-added tokens and detects contract
 * drift when actual usage is reconciled.
 */
export const WORKERS_AI_TEMPLATE_TOKEN_OVERHEAD = 2_048;

/** Published rates for the more expensive non-fast `@cf/meta/llama-3.1-8b-instruct` variant. */
export const WORKERS_AI_CONSERVATIVE_INPUT_NEURONS_PER_MILLION_TOKENS = 25_608;
export const WORKERS_AI_CONSERVATIVE_OUTPUT_NEURONS_PER_MILLION_TOKENS = 75_147;

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

function neuronsForTokens(tokens: number, ratePerMillion: number): number {
  return (tokens * ratePerMillion) / 1_000_000;
}

/** Fails before reservation/provider invocation when the serialized request exceeds policy. */
export function assertWorkersAiRequestSize(requestUtf8Bytes: number): void {
  assertNonNegativeSafeInteger(requestUtf8Bytes, 'requestUtf8Bytes');
  if (requestUtf8Bytes === 0 || requestUtf8Bytes > WORKERS_AI_MAX_REQUEST_UTF8_BYTES) {
    throw new RangeError(
      `requestUtf8Bytes must be in [1, ${WORKERS_AI_MAX_REQUEST_UTF8_BYTES}], got ${requestUtf8Bytes}`,
    );
  }
}

/**
 * Deterministic reserve-before-call amount. The result is rounded upward once, after summing input
 * and maximum-output costs, so fractional Neurons can never be dropped.
 */
export function estimateWorkersAiNeurons(requestUtf8Bytes: number): number {
  assertWorkersAiRequestSize(requestUtf8Bytes);
  const conservativeInputTokens = requestUtf8Bytes + WORKERS_AI_TEMPLATE_TOKEN_OVERHEAD;
  return Math.ceil(
    neuronsForTokens(
      conservativeInputTokens,
      WORKERS_AI_CONSERVATIVE_INPUT_NEURONS_PER_MILLION_TOKENS,
    ) +
      neuronsForTokens(
        WORKERS_AI_MAX_OUTPUT_TOKENS,
        WORKERS_AI_CONSERVATIVE_OUTPUT_NEURONS_PER_MILLION_TOKENS,
      ),
  );
}

export interface WorkersAiTokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Converts complete provider token usage into the same conservative accounting unit. A provider
 * response with absent/partial usage must not call this function; its full reservation remains.
 */
export function workersAiNeuronsFromUsage(usage: WorkersAiTokenUsage): number {
  assertNonNegativeSafeInteger(usage.promptTokens, 'promptTokens');
  assertNonNegativeSafeInteger(usage.completionTokens, 'completionTokens');
  return Math.ceil(
    neuronsForTokens(usage.promptTokens, WORKERS_AI_CONSERVATIVE_INPUT_NEURONS_PER_MILLION_TOKENS) +
      neuronsForTokens(
        usage.completionTokens,
        WORKERS_AI_CONSERVATIVE_OUTPUT_NEURONS_PER_MILLION_TOKENS,
      ),
  );
}

export const WORKERS_AI_MAX_ESTIMATED_NEURONS_PER_CALL = estimateWorkersAiNeurons(
  WORKERS_AI_MAX_REQUEST_UTF8_BYTES,
);
