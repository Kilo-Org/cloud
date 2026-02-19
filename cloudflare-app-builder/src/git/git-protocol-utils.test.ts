import { describe, it, expect } from 'vitest';
import { formatPacketLine } from './git-protocol-utils';

describe('formatPacketLine', () => {
  it('length prefix counts UTF-8 bytes, not JS string length', () => {
    // '€' is U+20AC — 3 bytes in UTF-8 but 1 JS char.
    // Data: "€\n" → 4 UTF-8 bytes.  Packet = 4 (prefix) + 4 (data) = 0008.
    const line = '€\n';
    const result = formatPacketLine(line);
    const declaredLen = parseInt(result.substring(0, 4), 16);
    const actualByteLen = new TextEncoder().encode(line).length + 4;

    expect(declaredLen).toBe(actualByteLen); // 8, not 6
  });

  it('length prefix is correct for ASCII-only data', () => {
    const line = 'hello\n';
    const result = formatPacketLine(line);
    const declaredLen = parseInt(result.substring(0, 4), 16);

    // "hello\n" = 6 bytes + 4 prefix = 10
    expect(declaredLen).toBe(10);
    expect(result).toBe('000ahello\n');
  });
});
