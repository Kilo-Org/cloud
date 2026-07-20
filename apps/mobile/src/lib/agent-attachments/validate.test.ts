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
} from './validate';

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

  it('rejects a file over the 5 MB cap', () => {
    expect(classifyAttachment({ name: 'big.pdf', size: 6 * 1024 * 1024 })).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('accepts a file exactly at the 5 MB cap', () => {
    expect(classifyAttachment({ name: 'edge.pdf', size: 5 * 1024 * 1024 })).toEqual({
      ok: true,
      kind: 'document',
      extension: 'pdf',
      size: 5 * 1024 * 1024,
    });
  });

  it('checks the deny list before the size cap (a 5 MB .exe is denied, not too-large)', () => {
    expect(classifyAttachment({ name: 'big.exe', size: 5 * 1024 * 1024 + 1 })).toEqual({
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
    expect(describeClassificationFailure('too-large')).toMatch(/5 MB/);
  });
});

describe('mimeForExtension (cross-surface parity)', () => {
  it('returns the canonical MIME for every documented extension', () => {
    expect(mimeForExtension('png')).toBe('image/png');
    expect(mimeForExtension('jpg')).toBe('image/jpeg');
    expect(mimeForExtension('jpeg')).toBe('image/jpeg');
    expect(mimeForExtension('webp')).toBe('image/webp');
    expect(mimeForExtension('gif')).toBe('image/gif');
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
