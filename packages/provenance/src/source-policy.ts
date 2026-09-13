import { z } from 'zod';
import { AiPolicySchema, SourceSchema } from '@pdos/contracts';

/** Mirrors the D1 `source_policies` row shape (type-design-analyzer, G2). */
export const SourcePolicyRecordSchema = z
  .object({
    source_policy_id: z.string().min(1),
    source: SourceSchema,
    ai_policy: AiPolicySchema,
    version: z.number().int().positive(),
  })
  .strict();

export type SourcePolicyRecord = z.infer<typeof SourcePolicyRecordSchema>;

/** Returns `undefined` for an unresolvable id -- `sourceEventNode` treats that as a violation, not
 *  a permissive default, since an unresolved policy must never be silently treated as safe. */
export type SourcePolicyLookup = (sourcePolicyId: string) => SourcePolicyRecord | undefined;
