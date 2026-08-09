import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { concatenateBytes, gzipMember, gzipMemberFitsPart, gzipPaddingMember } from './gzip';
import { exportArtifact } from './worker';

describe('gzip export members', () => {
  it('concatenates independently compressed JSONL members into one gzip stream', async () => {
    const header = await gzipMember('{"type":"header"}\n');
    const record = await gzipMember('{"value":"hello"}\n');
    const padding = await gzipPaddingMember(1024);
    const archive = concatenateBytes(
      [header, record, padding],
      header.byteLength + record.byteLength + padding.byteLength
    );

    expect(gunzipSync(archive).toString()).toBe('{"type":"header"}\n{"value":"hello"}\n');
    expect(padding.byteLength).toBe(1024);
  });

  it('leaves enough room for a complete padding member', () => {
    expect(gzipMemberFitsPart(100, 80, 200, 20)).toBe(true);
    expect(gzipMemberFitsPart(100, 81, 200, 20)).toBe(false);
    expect(gzipMemberFitsPart(100, 100, 200, 20)).toBe(true);
  });

  it('stores a gzip archive without HTTP content encoding', () => {
    expect(exportArtifact).toEqual({
      contentDisposition: 'attachment; filename="kilo-data-export.jsonl.gz"',
      contentType: 'application/gzip',
      partBytes: 5 * 1024 * 1024,
    });
    expect(exportArtifact).not.toHaveProperty('contentEncoding');
  });
});
