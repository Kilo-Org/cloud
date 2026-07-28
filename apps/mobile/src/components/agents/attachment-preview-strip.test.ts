import { describe, expect, it } from 'vitest';

import {
  type ChipStateInput,
  describeAttachmentChip,
  progressLabel,
} from './attachment-chip-description';

const baseState: ChipStateInput = {
  filename: 'doc.pdf',
  size: 1024,
  status: 'uploaded',
  progress: 1,
};

describe('progressLabel', () => {
  it('renders a percentage for determinate progress', () => {
    expect(progressLabel(0.42)).toBe('42%');
    expect(progressLabel(0)).toBe('0%');
  });

  it('renders "Uploaded" once progress reaches 1', () => {
    expect(progressLabel(1)).toBe('Uploaded');
  });

  it('renders "Uploading…" when progress is null (indeterminate)', () => {
    expect(progressLabel(null)).toBe('Uploading…');
  });
});

describe('describeAttachmentChip — happy / in-flight', () => {
  it('shows filename and human-readable size for a fully uploaded chip', () => {
    const desc = describeAttachmentChip(baseState);
    expect(desc.filename).toBe('doc.pdf');
    expect(desc.sizeText).toBe('1 KB');
    expect(desc.progressText).toBe('Uploaded');
    expect(desc.message).toBeNull();
    expect(desc.showRetry).toBe(false);
    expect(desc.showRemove).toBe(true);
  });

  it('shows determinate progress while uploading', () => {
    const desc = describeAttachmentChip({
      ...baseState,
      status: 'uploading',
      progress: 0.42,
    });
    expect(desc.progressText).toBe('42%');
    expect(desc.message).toBeNull();
    expect(desc.showRetry).toBe(false);
    expect(desc.showRemove).toBe(true);
    // Size and filename are still surfaced so the user knows what is uploading.
    expect(desc.sizeText).toBe('1 KB');
    expect(desc.filename).toBe('doc.pdf');
  });

  it('shows indeterminate progress honestly when the server did not advertise a total', () => {
    const desc = describeAttachmentChip({
      ...baseState,
      status: 'uploading',
      progress: null,
    });
    expect(desc.progressText).toBe('Uploading…');
    expect(desc.message).toBeNull();
    expect(desc.showRetry).toBe(false);
  });

  it('surfaces filename + human size for a pending chip before any progress is known', () => {
    const desc = describeAttachmentChip({
      ...baseState,
      status: 'pending',
      progress: 0,
    });
    expect(desc.filename).toBe('doc.pdf');
    expect(desc.sizeText).toBe('1 KB');
    expect(desc.progressText).toBe('0%');
    expect(desc.message).toBeNull();
  });
});

describe('describeAttachmentChip — unhappy, retryable (network/timeout/408/429/5xx/PUT)', () => {
  it('shows the retry copy and enables the tap-to-retry affordance', () => {
    const desc = describeAttachmentChip({
      ...baseState,
      status: 'error',
      progress: null,
      terminal: false,
    });
    expect(desc.message).toBe('Upload failed. Tap to retry.');
    expect(desc.showRetry).toBe(true);
    expect(desc.showRemove).toBe(true);
    // Size + filename are still surfaced so the user knows which file failed.
    expect(desc.sizeText).toBe('1 KB');
    expect(desc.filename).toBe('doc.pdf');
  });

  it('keeps showRetry=false when terminal is undefined (defensive default = non-retryable)', () => {
    // A missing `terminal` flag must not silently turn into a retryable chip;
    // the explicit contract is `terminal: true` for permanent failures.
    const desc = describeAttachmentChip({
      ...baseState,
      status: 'error',
      progress: null,
    });
    expect(desc.showRetry).toBe(false);
    expect(desc.message).toBe("This file can't be uploaded.");
  });
});

describe('describeAttachmentChip — unhappy, non-retryable (presign BAD_REQUEST/FORBIDDEN/UNPROCESSABLE_CONTENT)', () => {
  it('shows the terminal copy and disables the tap-to-retry affordance', () => {
    const desc = describeAttachmentChip({
      ...baseState,
      status: 'error',
      progress: null,
      terminal: true,
    });
    expect(desc.message).toBe("This file can't be uploaded.");
    expect(desc.showRetry).toBe(false);
    // Remove (X) MUST stay available so the user can clear the chip and
    // unblock send.
    expect(desc.showRemove).toBe(true);
    // Filename + size are still surfaced so the user knows which file is
    // permanently rejected.
    expect(desc.filename).toBe('doc.pdf');
    expect(desc.sizeText).toBe('1 KB');
  });

  it('keeps progressText empty for terminal failures (no percent leaked into the message)', () => {
    const desc = describeAttachmentChip({
      ...baseState,
      status: 'error',
      progress: 0.5,
      terminal: true,
    });
    expect(desc.progressText).toBe('');
  });
});

describe('describeAttachmentChip — feature-state invariants', () => {
  const states: ChipStateInput[] = [
    { ...baseState, status: 'pending', progress: 0 },
    { ...baseState, status: 'uploading', progress: 0.42 },
    { ...baseState, status: 'uploaded', progress: 1 },
    { ...baseState, status: 'error', terminal: false, progress: null },
    { ...baseState, status: 'error', terminal: true, progress: null },
  ];

  for (const state of states) {
    it(`always surfaces filename + human size for status=${state.status} terminal=${Boolean(state.terminal)}`, () => {
      const desc = describeAttachmentChip(state);
      expect(desc.filename).toBe(state.filename);
      expect(desc.sizeText.length).toBeGreaterThan(0);
    });
  }

  for (const state of states) {
    it(`always keeps the remove (X) affordance for status=${state.status} terminal=${Boolean(state.terminal)}`, () => {
      const desc = describeAttachmentChip(state);
      expect(desc.showRemove).toBe(true);
    });
  }

  it('never merges retryable and non-retryable error affordances', () => {
    const retryable = describeAttachmentChip({
      ...baseState,
      status: 'error',
      terminal: false,
    });
    const terminal = describeAttachmentChip({
      ...baseState,
      status: 'error',
      terminal: true,
    });
    expect(retryable.showRetry).toBe(true);
    expect(terminal.showRetry).toBe(false);
    // Both keep the remove affordance — that is the only affordance in common.
    expect(retryable.showRemove).toBe(true);
    expect(terminal.showRemove).toBe(true);
    // The error messages must not collapse to the same string.
    expect(retryable.message).not.toBe(terminal.message);
  });
});
