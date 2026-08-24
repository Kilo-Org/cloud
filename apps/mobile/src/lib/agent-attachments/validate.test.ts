import { describe, expect, it } from 'vitest';

import {
  AGENT_ATTACHMENT_DENIED_EXTENSIONS,
  AGENT_ATTACHMENT_MIME_BY_EXTENSION,
  type AgentAttachmentExtension,
} from './constants';
import {
  canAddAttachments,
  classifyAttachment,
  describeClassificationFailure,
  mimeForExtension,
  normalizeAttachmentExtension,
  sanitizeAttachmentFilename,
} from './validate';
import { utf8ByteLength } from '../utf8-utils';

describe('normalizeAttachmentExtension', () => {
  it('lowercases a known extension', () => {
    expect(normalizeAttachmentExtension('NOTES.PDF')).toBe('pdf');
  });

  it('returns the fallback when the filename has no extension', () => {
    expect(normalizeAttachmentExtension('README')).toBe('bin');
  });

  it('returns the fallback for an extension that violates the regex', () => {
    expect(normalizeAttachmentExtension('evil.tar!@#')).toBe('bin');
    expect(normalizeAttachmentExtension(`archive.${'a'.repeat(32)}`)).toBe('bin');
  });

  it('returns the fallback when the filename ends in a dot', () => {
    expect(normalizeAttachmentExtension('weird.')).toBe('bin');
  });

  it('accepts an extension that is not in the canonical table but matches the regex', () => {
    // `mov` is not in AGENT_ATTACHMENT_MIME_BY_EXTENSION; the classifier
    // must still produce a normalized extension and let the MIME fallback
    // take over. We rely on the fallback only — the caller is expected to
    // also fall through to `bin` if the MIME lookup would fail.
    const ext = normalizeAttachmentExtension('clip.mov');
    expect(ext).toBe('mov');
  });
});

describe('sanitizeAttachmentFilename', () => {
  it('passes a safe picker name unchanged', () => {
    expect(sanitizeAttachmentFilename('inbound-8mib.bin')).toBe('inbound-8mib.bin');
  });

  it('passes common safe names unchanged', () => {
    expect(sanitizeAttachmentFilename('archive.zip')).toBe('archive.zip');
    expect(sanitizeAttachmentFilename('notes.txt')).toBe('notes.txt');
    expect(sanitizeAttachmentFilename('image.png')).toBe('image.png');
    expect(sanitizeAttachmentFilename('report.PDF')).toBe('report.PDF');
    expect(sanitizeAttachmentFilename('some_large_document-v2.pdf')).toBe(
      'some_large_document-v2.pdf'
    );
  });

  it('strips directory traversal with forward slash', () => {
    // Basename extraction drops the directory prefix; the isolated
    // basename is safe because it has no separators.
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFilename('a/../../../b.txt')).toBe('b.txt');
    expect(sanitizeAttachmentFilename('/root/secret.key')).toBe('secret.key');
  });

  it('strips directory traversal with backslash', () => {
    expect(sanitizeAttachmentFilename(String.raw`..\..\windows\system.ini`)).toBe('system.ini');
    expect(sanitizeAttachmentFilename(String.raw`C:\Users\admin\desktop.ini`)).toBe('desktop.ini');
  });

  it('maps bare traversal tokens to safe fallback', () => {
    // Direct traversal tokens reach the sanitizer when the picker
    // reports a raw name that IS the traversal entry itself.
    expect(sanitizeAttachmentFilename('.')).toBe('file.bin');
    expect(sanitizeAttachmentFilename('..')).toBe('file.bin');
  });

  it('maps path-prefixed traversal tokens to safe fallback', () => {
    // The basename is `..` after prefix stripping; it must fall back.
    expect(sanitizeAttachmentFilename('../..')).toBe('file.bin');
    expect(sanitizeAttachmentFilename('a/..')).toBe('file.bin');
    expect(sanitizeAttachmentFilename(String.raw`..\..`)).toBe('file.bin');
  });

  it('preserves safe names with multiple consecutive dots', () => {
    expect(sanitizeAttachmentFilename('file..backup.txt')).toBe('file..backup.txt');
    expect(sanitizeAttachmentFilename('version..2.bin')).toBe('version..2.bin');
    expect(sanitizeAttachmentFilename('a...b.txt')).toBe('a...b.txt');
  });

  it('strips control characters', () => {
    expect(sanitizeAttachmentFilename('test\u0000file.txt')).toBe('testfile.txt');
    expect(sanitizeAttachmentFilename('foo\u001Fbar.bin')).toBe('foobar.bin');
    expect(sanitizeAttachmentFilename('name\u007F.txt')).toBe('name.txt');
  });

  it('truncates excess UTF-8 bytes to 255 and preserves the extension', () => {
    const long = `${'a'.repeat(500)}.txt`;
    const result = sanitizeAttachmentFilename(long);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(255);
    expect(utf8ByteLength(result)).toBe(255);
    expect(result.endsWith('.txt')).toBe(true);
  });

  it('truncates a multibyte filename to at most 255 bytes without unpaired surrogates', () => {
    // 🌟 is U+1F31F, encoded as surrogate pair \uD83C\uDF1F, 4 UTF-8 bytes each
    const star = '🌟';
    const long = star.repeat(300);
    const result = sanitizeAttachmentFilename(long);
    // No unpaired surrogates
    const hasUnpaired =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result);
    expect(hasUnpaired).toBe(false);
    // Byte count stays within the bound (each star is 4 UTF-8 bytes)
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(255);
    // 63 stars × 4 bytes = 252 bytes; 64 × 4 = 256 > 255
    expect(utf8ByteLength(result)).toBe(252);
  });

  it('preserves the extension when truncating a multibyte filename', () => {
    // 日本語 = 3 CJK chars, each 3 UTF-8 bytes = 9 bytes per unit
    const cjk = '日本語';
    // 30 repetitions = 270 bytes for name, extension "txt" = 3 bytes, dot = 1 byte
    // Budget: 255 - 3 - 1 = 251 bytes for name → 251 / 9 = 27 full chars = 243 bytes
    const long = `${cjk.repeat(30)}.txt`;
    const result = sanitizeAttachmentFilename(long);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(255);
    expect(result.endsWith('.txt')).toBe(true);
  });

  it('preserves the extension for an extreme emoji name', () => {
    // 4 UTF-8 bytes
    const rocket = '🚀';
    const long = `${rocket.repeat(100)}.pdf`;
    const result = sanitizeAttachmentFilename(long);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(255);
    expect(result.endsWith('.pdf')).toBe(true);
    // No unpaired surrogates
    const hasUnpaired =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result);
    expect(hasUnpaired).toBe(false);
  });

  it('truncates without an extension when none is present', () => {
    // CJK-only filename, no dot → no extension to preserve
    const long = '日'.repeat(200);
    const result = sanitizeAttachmentFilename(long);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(255);
    // 85 × 3 = 255 bytes exactly
    expect(utf8ByteLength(result)).toBe(255);
    expect(result.includes('.')).toBe(false);
  });

  it('falls back when no complete stem code point fits in the name budget', () => {
    // ñ is U+00F1, 2 UTF-8 bytes. Extension is 253 ASCII bytes.
    // Total: 2 + 1 + 253 = 256 > 255. nameBudget = 255 - 253 - 1 = 1.
    // The 2-byte stem does not fit in 1 byte, so the truncated name is
    // empty. The result must NOT be ".a…a" — a leading-dot name.
    const ext253 = 'a'.repeat(253);
    const long = `ñ.${ext253}`;
    const result = sanitizeAttachmentFilename(long);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(255);
    // Must not start with a dot
    expect(result.startsWith('.')).toBe(false);
    // The stem ñ (2 bytes) + dot (1 byte) + 252 'a' chars = 255 bytes
    expect(utf8ByteLength(result)).toBe(255);
    expect(result.startsWith('ñ.')).toBe(true);
  });

  it('preserves extension from a safe ASCII name at the byte boundary', () => {
    // 251 'a' + '.txt' = 251 + 1 + 3 = 255 bytes
    const long = `${'a'.repeat(300)}.txt`;
    const result = sanitizeAttachmentFilename(long);
    expect(utf8ByteLength(result)).toBe(255);
    expect(result).toBe(`${'a'.repeat(251)}.txt`);
  });

  it('returns safe fallback for empty input', () => {
    expect(sanitizeAttachmentFilename('')).toBe('file.bin');
  });

  it('preserves whitespace-only filenames', () => {
    // Spaces are above control range so they survive. The CLI handles
    // whitespace-only filenames.
    expect(sanitizeAttachmentFilename('   ')).toBe('   ');
  });

  it('returns safe fallback for control-char-only input', () => {
    expect(sanitizeAttachmentFilename('\u0000\u0001\u0002')).toBe('file.bin');
    expect(sanitizeAttachmentFilename('\u001F\u007F')).toBe('file.bin');
  });

  it('preserves trailing dots', () => {
    expect(sanitizeAttachmentFilename('data.')).toBe('data.');
    expect(sanitizeAttachmentFilename('something....')).toBe('something....');
  });
});

describe('classifyAttachment', () => {
  it('accepts a PNG and reports the image kind', () => {
    expect(classifyAttachment({ name: 'a.PNG', size: 10 })).toEqual({
      ok: true,
      kind: 'image',
      extension: 'png',
      size: 10,
    });
  });

  it('accepts a markdown file and reports the document kind', () => {
    expect(classifyAttachment({ name: 'notes.md', size: 10 })).toEqual({
      ok: true,
      kind: 'document',
      extension: 'md',
      size: 10,
    });
  });

  it('classifies HEIC and HEIF names as images', () => {
    expect(classifyAttachment({ name: 'photo.HEIC', size: 10 })).toEqual({
      ok: true,
      kind: 'image',
      extension: 'heic',
      size: 10,
    });
    expect(classifyAttachment({ name: 'photo.heif', size: 10 })).toEqual({
      ok: true,
      kind: 'image',
      extension: 'heif',
      size: 10,
    });
  });

  it('accepts an extension outside the image/document allow-list as a generic binary', () => {
    expect(classifyAttachment({ name: 'archive.zip', size: 10 })).toEqual({
      ok: true,
      kind: 'document',
      extension: 'zip',
      size: 10,
    });
  });

  it('rejects a zero-byte file with reason=empty', () => {
    expect(classifyAttachment({ name: 'empty.pdf', size: 0 })).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('rejects a negative size (defensive) with reason=empty', () => {
    expect(classifyAttachment({ name: 'neg.pdf', size: -1 })).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('rejects a file whose extension is on the deny list', () => {
    expect(classifyAttachment({ name: 'malware.exe', size: 10 })).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('rejects every entry in AGENT_ATTACHMENT_DENIED_EXTENSIONS', () => {
    for (const ext of AGENT_ATTACHMENT_DENIED_EXTENSIONS) {
      const result = classifyAttachment({ name: `virus.${ext}`, size: 10 });
      expect(result, `expected ${ext} to be denied`).toEqual({ ok: false, reason: 'denied' });
    }
  });

  it('rejects a file over the 20 MB cap', () => {
    expect(classifyAttachment({ name: 'big.pdf', size: 21 * 1024 * 1024 })).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('accepts a file exactly at the 20 MB cap', () => {
    expect(classifyAttachment({ name: 'edge.pdf', size: 20 * 1024 * 1024 })).toEqual({
      ok: true,
      kind: 'document',
      extension: 'pdf',
      size: 20 * 1024 * 1024,
    });
  });

  it('checks the deny list before the size cap (a 20 MB .exe is denied, not too-large)', () => {
    expect(classifyAttachment({ name: 'big.exe', size: 20 * 1024 * 1024 + 1 })).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('checks empty before the deny list (a 0-byte .exe is empty, not denied)', () => {
    expect(classifyAttachment({ name: 'zero.exe', size: 0 })).toEqual({
      ok: false,
      reason: 'empty',
    });
  });
});

describe('canAddAttachments', () => {
  it('allows up to 5 total', () => {
    expect(canAddAttachments(3, 2)).toEqual({ ok: true, acceptedCount: 2 });
  });

  it('truncates past 5 and reports partial', () => {
    expect(canAddAttachments(4, 3)).toEqual({ ok: true, acceptedCount: 1, truncated: true });
  });

  it('rejects when already full', () => {
    expect(canAddAttachments(5, 1)).toEqual({ ok: false, acceptedCount: 0 });
  });
});

describe('describeClassificationFailure', () => {
  it('returns the locked copy for each reason', () => {
    expect(describeClassificationFailure('denied')).toMatch(/can't be attached/i);
    expect(describeClassificationFailure('empty')).toMatch(/empty/i);
    expect(describeClassificationFailure('too-large')).toMatch(/20 MB/);
    expect(describeClassificationFailure('unreadable')).toBe("Couldn't read this file");
  });
});

describe('mimeForExtension (cross-surface parity)', () => {
  it('returns the canonical MIME for every documented extension', () => {
    expect(mimeForExtension('png')).toBe('image/png');
    expect(mimeForExtension('jpg')).toBe('image/jpeg');
    expect(mimeForExtension('jpeg')).toBe('image/jpeg');
    expect(mimeForExtension('webp')).toBe('image/webp');
    expect(mimeForExtension('gif')).toBe('image/gif');
    expect(mimeForExtension('heic')).toBe('image/heic');
    expect(mimeForExtension('heif')).toBe('image/heif');
    expect(mimeForExtension('pdf')).toBe('application/pdf');
    expect(mimeForExtension('txt')).toBe('text/plain');
    expect(mimeForExtension('md')).toBe('text/plain');
    expect(mimeForExtension('ts')).toBe('text/plain');
    expect(mimeForExtension('bin')).toBe('application/octet-stream');
  });

  it('falls back to application/octet-stream for an extension not in the canonical table', () => {
    // The picker must NEVER trust the picker's reported MIME; when the
    // extension is not in the table the fallback is `application/octet-stream`.
    // The compose-time `normalizeAttachmentExtension` keeps the original
    // extension so the server can still distinguish `mov` vs `mp4`; the
    // caller's `mimeForExtension` lookup is the safety net.
    expect(mimeForExtension('mov' as AgentAttachmentExtension)).toBe('application/octet-stream');
  });
});

describe('AGENT_ATTACHMENT_MIME_BY_EXTENSION (server parity)', () => {
  it('resolves every key to a defined MIME string', () => {
    for (const [ext, mime] of Object.entries(AGENT_ATTACHMENT_MIME_BY_EXTENSION)) {
      expect(typeof mime).toBe('string');
      expect(mime.length).toBeGreaterThan(0);
      expect(ext.length).toBeGreaterThan(0);
    }
  });

  it('contains the fallback `bin` key', () => {
    expect(AGENT_ATTACHMENT_MIME_BY_EXTENSION.bin).toBe('application/octet-stream');
  });

  it('does not contain a denied extension as a key', () => {
    for (const ext of AGENT_ATTACHMENT_DENIED_EXTENSIONS) {
      expect(Object.hasOwn(AGENT_ATTACHMENT_MIME_BY_EXTENSION, ext)).toBe(false);
    }
  });
});
