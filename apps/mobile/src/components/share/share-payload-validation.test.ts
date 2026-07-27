import { describe, expect, it } from 'vitest';

import { describeClassificationFailure } from '@/lib/agent-attachments/validate';
import { AGENT_ATTACHMENT_MAX_BYTES } from '@/lib/agent-attachments/constants';

import { validateMeasuredShareFiles } from './share-payload-validation';

function file(name: string, measuredSize: number) {
  return {
    name,
    measuredSize,
    uri: `file:///${name}`,
  };
}

describe('validateMeasuredShareFiles', () => {
  it('maps each classification reason to describeClassificationFailure copy', () => {
    const cases: { reason: 'denied' | 'empty' | 'too-large'; name: string; size: number }[] = [
      { reason: 'denied', name: 'evil.exe', size: 10 },
      { reason: 'empty', name: 'notes.pdf', size: 0 },
      { reason: 'too-large', name: 'notes.pdf', size: AGENT_ATTACHMENT_MAX_BYTES + 1 },
    ];
    for (const { reason, name, size } of cases) {
      const result = validateMeasuredShareFiles({
        text: '',
        files: [file(name, size)],
      });
      expect(result.kind).toBe('all-rejected');
      if (result.kind === 'all-rejected') {
        expect(result.reason).toBe(reason);
        expect(result.message).toBe(describeClassificationFailure(reason));
      }
    }
  });

  it('all-rejected requires both all files rejected AND no usable text', () => {
    const deniedOnly = validateMeasuredShareFiles({
      text: '',
      files: [file('evil.exe', 10)],
    });
    expect(deniedOnly.kind).toBe('all-rejected');

    const deniedWithText = validateMeasuredShareFiles({
      text: 'hello',
      files: [file('evil.exe', 10)],
    });
    expect(deniedWithText.kind).toBe('ok');
    if (deniedWithText.kind === 'ok') {
      expect(deniedWithText.accepted).toHaveLength(0);
      expect(deniedWithText.rejectedNotes).toEqual([{ name: 'evil.exe', reason: 'denied' }]);
      expect(deniedWithText.usable).toBe(true);
    }
  });

  it('partial rejection keeps accepted files and rejected notes', () => {
    const result = validateMeasuredShareFiles({
      text: '',
      files: [file('good.png', 100), file('bad.exe', 10), file('empty.pdf', 0)],
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.accepted.map(f => f.name)).toEqual(['good.png']);
      expect(result.rejectedNotes).toEqual([
        { name: 'bad.exe', reason: 'denied' },
        { name: 'empty.pdf', reason: 'empty' },
      ]);
      expect(result.truncated).toBe(false);
      expect(result.usable).toBe(true);
    }
  });

  it('truncates at 5 acceptable files', () => {
    const files = Array.from({ length: 7 }, (_, i) => file(`f${i}.png`, 10));
    const result = validateMeasuredShareFiles({ text: '', files });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.accepted).toHaveLength(5);
      expect(result.truncated).toBe(true);
      expect(result.accepted.map(f => f.name)).toEqual([
        'f0.png',
        'f1.png',
        'f2.png',
        'f3.png',
        'f4.png',
      ]);
    }
  });

  it('treats unknown-but-not-denied extensions as documents', () => {
    const result = validateMeasuredShareFiles({
      text: '',
      files: [file('blob.bin', 10)],
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.accepted[0]?.kind).toBe('document');
    }
  });

  it('whitespace-only text is not usable', () => {
    const result = validateMeasuredShareFiles({
      text: '   \n\t  ',
      files: [file('evil.exe', 10)],
    });
    expect(result.kind).toBe('all-rejected');
  });

  it('text-only payload with no files is ok and usable', () => {
    const result = validateMeasuredShareFiles({ text: 'shared link', files: [] });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.usable).toBe(true);
      expect(result.accepted).toHaveLength(0);
    }
  });

  it('contentless payload uses dedicated message and null reason', () => {
    const result = validateMeasuredShareFiles({ text: '', files: [] });
    expect(result.kind).toBe('all-rejected');
    if (result.kind === 'all-rejected') {
      expect(result.reason).toBeNull();
      expect(result.message).toBe('Nothing to share — no text or files were included.');
    }
  });

  it('contentless whitespace-only text with no files uses dedicated message', () => {
    const result = validateMeasuredShareFiles({ text: '   \n\t  ', files: [] });
    expect(result.kind).toBe('all-rejected');
    if (result.kind === 'all-rejected') {
      expect(result.reason).toBeNull();
      expect(result.message).toBe('Nothing to share — no text or files were included.');
    }
  });

  it('single rejection keeps describeClassificationFailure copy', () => {
    const result = validateMeasuredShareFiles({
      text: '',
      files: [file('evil.exe', 10)],
    });
    expect(result.kind).toBe('all-rejected');
    if (result.kind === 'all-rejected') {
      expect(result.reason).toBe('denied');
      expect(result.message).toBe(describeClassificationFailure('denied'));
    }
  });

  it('mixed rejections with no accepted use first rejection copy', () => {
    const result = validateMeasuredShareFiles({
      text: '',
      files: [file('bad.exe', 10), file('empty.pdf', 0)],
    });
    expect(result.kind).toBe('all-rejected');
    if (result.kind === 'all-rejected') {
      expect(result.reason).toBe('denied');
      expect(result.message).toBe(describeClassificationFailure('denied'));
    }
  });

  it('appends unreadable notes after classification notes', () => {
    const result = validateMeasuredShareFiles({
      text: 'caption',
      files: [file('good.png', 100), file('bad.exe', 10)],
      failedCopies: ['lost.jpg', 'gone.png'],
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.accepted.map(f => f.name)).toEqual(['good.png']);
      expect(result.rejectedNotes).toEqual([
        { name: 'bad.exe', reason: 'denied' },
        { name: 'lost.jpg', reason: 'unreadable' },
        { name: 'gone.png', reason: 'unreadable' },
      ]);
      expect(result.usable).toBe(true);
    }
  });

  it('text + all-copies-failed is ok/usable with unreadable notes (not clean text-only)', () => {
    const result = validateMeasuredShareFiles({
      text: 'caption only',
      files: [],
      failedCopies: ['a.jpg', 'b.jpg'],
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.usable).toBe(true);
      expect(result.accepted).toHaveLength(0);
      expect(result.rejectedNotes).toEqual([
        { name: 'a.jpg', reason: 'unreadable' },
        { name: 'b.jpg', reason: 'unreadable' },
      ]);
    }

    const cleanTextOnly = validateMeasuredShareFiles({
      text: 'caption only',
      files: [],
    });
    expect(cleanTextOnly.kind).toBe('ok');
    if (cleanTextOnly.kind === 'ok') {
      expect(cleanTextOnly.rejectedNotes).toEqual([]);
      expect(result).not.toEqual(cleanTextOnly);
    }
  });

  it('failed copies alone without text remain all-rejected and do not invent usable', () => {
    const result = validateMeasuredShareFiles({
      text: '',
      files: [],
      failedCopies: ['a.jpg'],
    });
    expect(result.kind).toBe('all-rejected');
    if (result.kind === 'all-rejected') {
      expect(result.reason).toBe('unreadable');
      expect(result.message).toBe(describeClassificationFailure('unreadable'));
    }
  });
});
