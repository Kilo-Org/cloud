import { describe, expect, it, vi } from 'vitest';

import {
  safeArtifactDisplayName,
  uniqueArtifactDisplayNames,
} from '@/lib/artifacts/artifact-mirror-manifest';
import { utf8ByteLength } from '@/lib/utf8-utils';

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(),
  File: vi.fn(),
  Paths: {},
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

function fileOf(id: string, name: string, mime = 'application/pdf') {
  return { id, name, mime, size: 1 };
}

describe('uniqueArtifactDisplayNames', () => {
  it('leaves distinct names untouched', () => {
    const files = [fileOf('f1', 'a.pdf'), fileOf('f2', 'b.pdf')];

    expect(uniqueArtifactDisplayNames(files).map(file => file.name)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('suffixes duplicates before the extension, keeping the first name', () => {
    const files = [
      fileOf('f1', 'report.pdf'),
      fileOf('f2', 'report.pdf'),
      fileOf('f3', 'report.pdf'),
    ];

    expect(uniqueArtifactDisplayNames(files).map(file => file.name)).toEqual([
      'report.pdf',
      'report (2).pdf',
      'report (3).pdf',
    ]);
  });

  it('suffixes a name with no extension', () => {
    const files = [fileOf('f1', 'notes'), fileOf('f2', 'notes')];

    expect(uniqueArtifactDisplayNames(files).map(file => file.name)).toEqual([
      'notes',
      'notes (2)',
    ]);
  });

  it('keeps every suffixed name inside the byte bound and its extension', () => {
    const longBase = safeArtifactDisplayName({
      id: 'f1',
      name: `${'ä'.repeat(300)}.pdf`,
      mime: 'application/pdf',
    });
    const files = [fileOf('f1', longBase), fileOf('f2', longBase)];

    const names = uniqueArtifactDisplayNames(files).map(file => file.name);
    expect(names[0]).not.toBe(names[1]);
    for (const value of names) {
      expect(utf8ByteLength(value)).toBeLessThanOrEqual(200);
      expect(value.endsWith('.pdf')).toBe(true);
    }
  });

  it('does not mutate the input files', () => {
    const files = [fileOf('f1', 'report.pdf'), fileOf('f2', 'report.pdf')];

    uniqueArtifactDisplayNames(files);

    expect(files.map(file => file.name)).toEqual(['report.pdf', 'report.pdf']);
  });
});
