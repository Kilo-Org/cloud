import { type FilePart, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  getToolFileAttachments,
  getToolImageAttachments,
  IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO,
  IMAGE_PREVIEW_MAX_ASPECT_RATIO,
  IMAGE_PREVIEW_MIN_ASPECT_RATIO,
  resolveImagePreviewAspectRatio,
} from './tool-card-attachments';

function makeAttachment(mime: string, url: string): FilePart {
  return {
    id: 'att-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime,
    url,
  };
}

function makeToolPart(
  status: ToolPart['state']['status'],
  attachments?: FilePart[],
  tool = 'read'
): ToolPart {
  const base = {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool' as const,
    callID: 'call-1',
    tool,
  };

  if (status === 'pending') {
    return { ...base, state: { status: 'pending', input: {}, raw: '' } };
  }
  if (status === 'running') {
    return { ...base, state: { status: 'running', input: {}, time: { start: 0 } } };
  }
  if (status === 'error') {
    return {
      ...base,
      state: {
        status: 'error',
        input: {},
        error: 'failed',
        time: { start: 0, end: 1 },
      },
    };
  }
  return {
    ...base,
    state: {
      status: 'completed',
      input: { filePath: '/repo/shot.png' },
      output: 'Image read successfully',
      title: 'read',
      metadata: {},
      time: { start: 0, end: 1 },
      ...(attachments !== undefined ? { attachments } : {}),
    },
  };
}

describe('getToolImageAttachments', () => {
  it('returns empty for pending, running, and error states', () => {
    expect(getToolImageAttachments(makeToolPart('pending'))).toEqual([]);
    expect(getToolImageAttachments(makeToolPart('running'))).toEqual([]);
    expect(getToolImageAttachments(makeToolPart('error'))).toEqual([]);
  });

  it('returns empty when attachments key is absent', () => {
    expect(getToolImageAttachments(makeToolPart('completed'))).toEqual([]);
  });

  it('keeps image/png and image/jpeg attachments', () => {
    const png = makeAttachment('image/png', 'data:image/png;base64,AAA');
    const jpeg = makeAttachment('image/jpeg', 'data:image/jpeg;base64,BBB');
    const result = getToolImageAttachments(makeToolPart('completed', [png, jpeg]));
    expect(result).toEqual([png, jpeg]);
  });

  it('drops non-image mimes', () => {
    const pdf = makeAttachment('application/pdf', 'data:application/pdf;base64,CCC');
    expect(getToolImageAttachments(makeToolPart('completed', [pdf]))).toEqual([]);
  });

  it('keeps blank-url image attachments', () => {
    const blank = makeAttachment('image/png', '');
    expect(getToolImageAttachments(makeToolPart('completed', [blank]))).toEqual([blank]);
  });

  it('filters a mixed array in original order', () => {
    const png = makeAttachment('image/png', '');
    const pdf = makeAttachment('application/pdf', '');
    const jpeg = makeAttachment('image/jpeg', '');
    const result = getToolImageAttachments(makeToolPart('completed', [png, pdf, jpeg]));
    expect(result).toEqual([png, jpeg]);
  });
});

describe('getToolFileAttachments', () => {
  it('returns empty for non-send_file tools even when completed', () => {
    const pdf = makeAttachment('application/pdf', '');
    expect(getToolFileAttachments(makeToolPart('completed', [pdf], 'read'))).toEqual([]);
  });

  it('returns empty when attachments key is absent', () => {
    expect(getToolFileAttachments(makeToolPart('completed', undefined, 'send_file'))).toEqual([]);
  });

  it('returns empty for pending, running, and error states', () => {
    const pdf = makeAttachment('application/pdf', '');
    expect(getToolFileAttachments(makeToolPart('pending', [pdf], 'send_file'))).toEqual([]);
    expect(getToolFileAttachments(makeToolPart('running', [pdf], 'send_file'))).toEqual([]);
    expect(getToolFileAttachments(makeToolPart('error', [pdf], 'send_file'))).toEqual([]);
  });

  it('keeps non-image attachments from send_file', () => {
    const pdf = makeAttachment('application/pdf', '');
    const txt = makeAttachment('text/plain', '');
    const result = getToolFileAttachments(makeToolPart('completed', [pdf, txt], 'send_file'));
    expect(result).toEqual([pdf, txt]);
  });

  it('drops image attachments (they belong to image rendering)', () => {
    const png = makeAttachment('image/png', '');
    const pdf = makeAttachment('application/pdf', '');
    const result = getToolFileAttachments(makeToolPart('completed', [png, pdf], 'send_file'));
    expect(result).toEqual([pdf]);
  });

  it('keeps blank-url non-image attachments', () => {
    const pdf = makeAttachment('application/pdf', '');
    expect(getToolFileAttachments(makeToolPart('completed', [pdf], 'send_file'))).toEqual([pdf]);
  });

  it('filters a mixed array preserving order', () => {
    const pdf = makeAttachment('application/pdf', '');
    const png = makeAttachment('image/png', '');
    const txt = makeAttachment('text/plain', '');
    const result = getToolFileAttachments(makeToolPart('completed', [pdf, png, txt], 'send_file'));
    expect(result).toEqual([pdf, txt]);
  });
});

describe('resolveImagePreviewAspectRatio', () => {
  it('passes through a normal landscape ratio', () => {
    expect(resolveImagePreviewAspectRatio(1600, 900)).toBeCloseTo(1600 / 900);
  });

  it('clamps a tall phone screenshot to the min', () => {
    expect(resolveImagePreviewAspectRatio(1170, 2532)).toBe(IMAGE_PREVIEW_MIN_ASPECT_RATIO);
  });

  it('clamps a very wide image to the max', () => {
    expect(resolveImagePreviewAspectRatio(4000, 500)).toBe(IMAGE_PREVIEW_MAX_ASPECT_RATIO);
  });

  it('returns the fallback for non-finite or non-positive dimensions', () => {
    expect(resolveImagePreviewAspectRatio(0, 100)).toBe(IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO);
    expect(resolveImagePreviewAspectRatio(100, 0)).toBe(IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO);
    expect(resolveImagePreviewAspectRatio(-1, 100)).toBe(IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO);
    expect(resolveImagePreviewAspectRatio(100, -1)).toBe(IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO);
    expect(resolveImagePreviewAspectRatio(Number.NaN, 100)).toBe(
      IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO
    );
    expect(resolveImagePreviewAspectRatio(100, Number.NaN)).toBe(
      IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO
    );
    expect(resolveImagePreviewAspectRatio(Number.POSITIVE_INFINITY, 100)).toBe(
      IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO
    );
    expect(resolveImagePreviewAspectRatio(100, Number.POSITIVE_INFINITY)).toBe(
      IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO
    );
  });
});
