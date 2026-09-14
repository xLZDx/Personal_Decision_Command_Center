import { z } from 'zod';

const BackupEntrySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._/-]+$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative().max(10_000_000),
});

export const BackupManifestSchema = z
  .object({
    version: z.literal(1),
    backupId: z.string().uuid(),
    createdAt: z.string().datetime({ offset: true }),
    encrypted: z.literal(true),
    entries: z.array(BackupEntrySchema).min(1).max(1024),
  })
  .strict();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export function validateBackupManifest(input: unknown): BackupManifest {
  return BackupManifestSchema.parse(input);
}

export function assertBackupIntegrity(
  manifest: BackupManifest,
  observed: readonly { path: string; sha256: string }[],
): void {
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry.sha256]));
  for (const item of observed) {
    if (expected.get(item.path) !== item.sha256)
      throw new Error(`backup checksum mismatch: ${item.path}`);
  }
  if (observed.length !== expected.size) throw new Error('backup manifest entry count mismatch');
}
