import { strToU8, zipSync } from 'fflate';

/** Build a real deflate ZIP from a path → content map (fflate's normal path). */
export function buildZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const payload: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    payload[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(payload);
}

/**
 * A wrapped archive shaped like a real `~/.config/kilo/` directory, shared by
 * the mapper tests and by the runtime-contract parity proof so the mapper's
 * real output can be validated against the authoritative runtime schemas.
 */
export function buildRepresentativeImportArchive(): Uint8Array {
  return buildZip({
    'kilo-config/kilo.jsonc': `{
      // JSONC comments and trailing commas are accepted.
      "mcp": { "server": { "type": "local" } },
      "agent": {
        "triage": {
          "description": "Triage issues",
          "mode": "subagent",
          "model": "anthropic/claude-sonnet-4",
          "temperature": 0.2,
          "prompt": "You triage.",
        },
      },
      "command": {
        "explain": {
          "description": "Explain code",
          "template": "Explain $ARGUMENTS",
          "agent": "triage",
          "model": "anthropic/claude-sonnet-4",
        },
      },
      "instructions": ["AGENTS.md"],
    }`,
    'kilo-config/agent/reviewer.md': [
      '---',
      'description: Reviews pull requests',
      'mode: subagent',
      'model: anthropic/claude-sonnet-4',
      'variant: high',
      'temperature: 0.3',
      'permission:',
      '  edit: deny',
      '  bash:',
      '    "git *": allow',
      '---',
      'Review the diff carefully.',
    ].join('\n'),
    'kilo-config/agents/auditor.md': ['---', 'description: Audits deps', '---', 'Audit.'].join(
      '\n'
    ),
    'kilo-config/command/fix.md': [
      '---',
      'description: Fix lint',
      'agent: reviewer',
      'model: anthropic/claude-sonnet-4',
      '---',
      'Fix $ARGUMENTS',
    ].join('\n'),
    'kilo-config/commands/ship.md': ['---', 'description: Ship it', '---', 'Ship.'].join('\n'),
    'kilo-config/skills/deploy/SKILL.md': [
      '---',
      'name: deploy',
      'description: Deploy services',
      '---',
      '# Deploy',
    ].join('\n'),
    'kilo-config/skills/deploy/scripts/run.sh': '#!/bin/sh\necho deploy',
    'kilo-config/instructions/coding-style.md': 'Prefer small functions.',
    'kilo-config/AGENTS.md': 'Repo-wide instructions.',
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type StoredZipEntry = {
  path: string;
  content: string | Uint8Array;
  /** Adversarial override for the stored-member size fields; defaults to the real length. */
  declaredCompressedSize?: number;
  declaredOriginalSize?: number;
  /** Adversarial override so several members can reference one stored payload. */
  declaredOffset?: number;
};

/**
 * Build a stored (uncompressed) ZIP that can contain repeated member paths and
 * adversarial size fields — fflate's writer keys entries by path and collapses
 * duplicates, and always records consistent sizes, so those fixtures must be
 * assembled by hand.
 */
export function buildStoredZip(entries: StoredZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const data = typeof entry.content === 'string' ? encoder.encode(entry.content) : entry.content;
    const declaredCompressed = entry.declaredCompressedSize ?? data.length;
    const declaredOriginal = entry.declaredOriginalSize ?? data.length;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, declaredCompressed, true);
    localView.setUint32(22, declaredOriginal, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localChunks.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, declaredCompressed, true);
    centralView.setUint32(24, declaredOriginal, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, entry.declaredOffset ?? offset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, 0, true);

  const output = new Uint8Array(offset + centralSize + eocd.length);
  let cursor = 0;
  for (const chunk of [...localChunks, ...centralChunks, eocd]) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}
