import { describe, expect, it } from 'vitest';

import { stripUnsafeFilenameCharacters } from '@/lib/filename-safety';

describe('stripUnsafeFilenameCharacters', () => {
  it('keeps only the basename of a path, dropping both separator styles', () => {
    expect(stripUnsafeFilenameCharacters('../../etc/passwd')).toBe('passwd');
    expect(stripUnsafeFilenameCharacters('/root/secret.key')).toBe('secret.key');
    expect(stripUnsafeFilenameCharacters(String.raw`..\..\windows\system.ini`)).toBe('system.ini');
    expect(stripUnsafeFilenameCharacters(String.raw`C:\Users\admin\desktop.ini`)).toBe(
      'desktop.ini'
    );
  });

  it('treats everything up to the last separator as the directory part', () => {
    // A trailing separator leaves no basename: the rule is the directory part
    // up to and including that final separator, so `passwd/` names no file.
    // The caller's fallback covers it.
    expect(stripUnsafeFilenameCharacters('passwd/')).toBe('');
    expect(stripUnsafeFilenameCharacters('a/b/')).toBe('');
  });

  it('takes the basename after removing the characters, not before', () => {
    // `.` in the basename pattern crosses no line terminator, so a terminator
    // in front of the last separator would hide the directory part.
    expect(stripUnsafeFilenameCharacters('a\n/b')).toBe('b');
    expect(stripUnsafeFilenameCharacters('../../etc\n/passwd')).toBe('passwd');
  });

  it('removes control characters, C0, DEL and C1', () => {
    expect(stripUnsafeFilenameCharacters('test\u0000file.txt')).toBe('testfile.txt');
    expect(stripUnsafeFilenameCharacters('a\u001Fb\u001Fc.bin')).toBe('abc.bin');
    expect(stripUnsafeFilenameCharacters('name\u007F.txt')).toBe('name.txt');
    expect(stripUnsafeFilenameCharacters('c1-\u0080\u009F.txt')).toBe('c1-.txt');
    expect(stripUnsafeFilenameCharacters('line\nbreak\r\tname.txt')).toBe('linebreakname.txt');
  });

  it('removes the line and paragraph separators, which are not controls', () => {
    // U+2028 and U+2029 are Zl and Zp, so a control-character test misses them
    // and a name holding one draws across two lines.
    expect(stripUnsafeFilenameCharacters('line\u2028sep\u2029par.txt')).toBe('lineseppar.txt');
  });

  it('removes a bidi override and the isolates', () => {
    // `report\u202Etxt.exe` displays as `reportexe.txt`, and an isolate hides
    // where a name starts and ends.
    expect(stripUnsafeFilenameCharacters('report\u202Etxt.exe')).toBe('reporttxt.exe');
    expect(stripUnsafeFilenameCharacters('a\u202Ab\u202Cc\u202Dd\u202Ee')).toBe('abcde');
    expect(stripUnsafeFilenameCharacters('a\u2066b\u2067c\u2068d\u2069e')).toBe('abcde');
  });

  it('passes accents, CJK, Arabic and spaces through byte for byte', () => {
    for (const filename of [
      'Rechnung-März.pdf',
      '報告書.pdf',
      'تقرير-مارس.pdf',
      'Rechnung März.pdf',
      '  double  spaced  .pdf',
    ]) {
      expect(stripUnsafeFilenameCharacters(filename)).toBe(filename);
    }
  });

  it('owns no fallback, trim or truncation', () => {
    // The callers that need a non-empty, trimmed, bounded result apply it.
    expect(stripUnsafeFilenameCharacters('   ')).toBe('   ');
    expect(stripUnsafeFilenameCharacters('///')).toBe('');
    expect(stripUnsafeFilenameCharacters('..')).toBe('..');
    expect(stripUnsafeFilenameCharacters(`${'報'.repeat(200)}.pdf`)).toBe(
      `${'報'.repeat(200)}.pdf`
    );
  });
});
