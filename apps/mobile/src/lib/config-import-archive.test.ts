import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  CONFIG_ARCHIVE_FILE_NAME,
  configImportArchiveFromText,
  MAX_CONFIG_IMPORT_TEXT_LENGTH,
} from '@/lib/config-import-archive';

/** Decode the base64 transport body and read the archive's members. */
function readArchive(archive: string): Record<string, string> {
  const bytes = Uint8Array.from(atob(archive), character => character.codePointAt(0) ?? 0);
  const entries = unzipSync(bytes);
  return Object.fromEntries(Object.entries(entries).map(([path, data]) => [path, strFromU8(data)]));
}

describe('configImportArchiveFromText', () => {
  it('refuses blank input', () => {
    expect(configImportArchiveFromText('   ')).toEqual({ ok: false, error: 'empty' });
  });

  it('packages the pasted config as the archive root config file', () => {
    const result = configImportArchiveFromText('{"agent":{"review":{}}}\n');
    if (!result.ok) {
      throw new Error('expected a packaged archive');
    }
    expect(readArchive(result.archive)).toEqual({
      [CONFIG_ARCHIVE_FILE_NAME]: '{"agent":{"review":{}}}',
    });
  });

  it('keeps non-ASCII content intact', () => {
    const result = configImportArchiveFromText('{"instructions":["rules/café.md"]}');
    if (!result.ok) {
      throw new Error('expected a packaged archive');
    }
    expect(readArchive(result.archive)[CONFIG_ARCHIVE_FILE_NAME]).toBe(
      '{"instructions":["rules/café.md"]}'
    );
  });

  it('refuses text over the paste budget', () => {
    const oversized = 'x'.repeat(MAX_CONFIG_IMPORT_TEXT_LENGTH + 1);
    expect(configImportArchiveFromText(oversized)).toEqual({ ok: false, error: 'too-large' });
  });
});
