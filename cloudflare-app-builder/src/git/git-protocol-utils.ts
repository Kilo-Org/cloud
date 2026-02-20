/**
 * Shared utilities for the git HTTP protocol (upload-pack & receive-pack).
 */

import type { MemFS } from './memfs';

const textEncoder = new TextEncoder();

/**
 * Determine which branch HEAD points to, for the symref capability.
 * Returns the full ref (e.g. "refs/heads/main") or null if HEAD is detached
 * with no matching branch.
 */
export async function resolveHeadSymref(fs: MemFS, branches: string[]): Promise<string | null> {
  try {
    const headContent = String(await fs.readFile('.git/HEAD', { encoding: 'utf8' })).trim();

    // Symbolic ref: "ref: refs/heads/main"
    if (headContent.startsWith('ref: ')) {
      return headContent.slice('ref: '.length);
    }

    // Raw OID (legacy repo): find a branch whose OID matches HEAD
    const headOid = headContent;

    // Prefer main > master > first match
    const preferred = ['main', 'master'];
    for (const name of preferred) {
      if (!branches.includes(name)) continue;
      try {
        const branchOid = String(
          await fs.readFile(`.git/refs/heads/${name}`, { encoding: 'utf8' })
        ).trim();
        if (branchOid === headOid) return `refs/heads/${name}`;
      } catch {
        // branch file missing
      }
    }

    for (const name of branches) {
      if (preferred.includes(name)) continue;
      try {
        const branchOid = String(
          await fs.readFile(`.git/refs/heads/${name}`, { encoding: 'utf8' })
        ).trim();
        if (branchOid === headOid) return `refs/heads/${name}`;
      } catch {
        // branch file missing
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Format git packet line (4-byte hex length prefix + data).
 * The length counts UTF-8 encoded bytes (not JS string length) per the git protocol spec.
 */
export function formatPacketLine(data: string): string {
  const byteLength = textEncoder.encode(data).length;
  const hexLength = (byteLength + 4).toString(16).padStart(4, '0');
  return hexLength + data;
}
