#!/usr/bin/env node
/**
 * Minimal in-repo secret scan.
 *
 * HONEST SCOPE: this is a pattern check over tracked files, not a real secret scanner. It cannot
 * find high-entropy strings it has no pattern for, and it does not scan git history. A proper
 * scanner (gitleaks) belongs in CI pinned to a specific action SHA -- deliberately not added here
 * rather than pinned to a SHA nobody verified, since an unverified third-party action in the
 * pipeline that guards secrets is worse than the gap it closes (TDD 37, supply-chain compromise).
 * Tracked as G1 debt; see core/RISK_REGISTER.md.
 *
 * What it does reliably catch is the realistic accident for this project: a Cloudflare/Google
 * token, a Telegram bot token, or a private key pasted into a config, fixture or runbook.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key block'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub fine-grained PAT'],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, 'Telegram bot token'],
  [/\bya29\.[A-Za-z0-9_-]{20,}\b/, 'Google OAuth access token'],
  [/\b1\/\/[A-Za-z0-9_-]{30,}\b/, 'Google OAuth refresh token'],
  [/"private_key_id"\s*:\s*"[a-f0-9]{40}"/, 'Google service-account key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [
    /\bCLOUDFLARE_API_(TOKEN|KEY)\s*[:=]\s*['"][A-Za-z0-9_-]{20,}['"]/,
    'hardcoded Cloudflare token',
  ],
];

// Skip this file: it necessarily contains the patterns it searches for.
const SELF = 'scripts/verify/check-secrets.mjs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => f !== SELF)
  .filter((f) => !/\.(docx|png|jpg|jpeg|gif|pdf|zip|ico|woff2?)$/i.test(f));

const findings = [];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable/binary -- not a place a pasted token hides in practice
  }

  const lines = content.split('\n');
  for (const [pattern, label] of PATTERNS) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        findings.push(`${file}:${index + 1}: possible ${label}`);
      }
    });
  }
}

if (findings.length > 0) {
  console.error('Secret scan found candidate secrets:\n');
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error(
    '\nIf a match is a false positive, narrow the pattern -- do not add a blanket ignore.',
  );
  process.exit(1);
}

console.log(`Secret scan: ${files.length} tracked files, no candidate secrets found.`);
