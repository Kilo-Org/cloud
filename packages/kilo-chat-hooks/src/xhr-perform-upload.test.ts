import { describe, expect, it } from 'vitest';

import { mapXhrUploadResultToOutcome } from './use-attachment-queue';

describe('mapXhrUploadResultToOutcome', () => {
  it('resolves successful 2xx uploads', () => {
    expect(mapXhrUploadResultToOutcome({ status: 200, aborted: false })).toEqual({ kind: 'ok' });
    expect(mapXhrUploadResultToOutcome({ status: 204, aborted: false })).toEqual({ kind: 'ok' });
  });

  it('marks aborted uploads regardless of status', () => {
    expect(mapXhrUploadResultToOutcome({ status: 0, aborted: true })).toEqual({
      kind: 'aborted',
    });
    expect(mapXhrUploadResultToOutcome({ status: 200, aborted: true })).toEqual({
      kind: 'aborted',
    });
  });

  it('maps network and HTTP errors', () => {
    expect(mapXhrUploadResultToOutcome({ status: 0, aborted: false })).toEqual({
      kind: 'error',
      message: 'Network error during upload',
    });
    expect(mapXhrUploadResultToOutcome({ status: 403, aborted: false })).toEqual({
      kind: 'error',
      message: 'Upload failed (403)',
    });
    expect(mapXhrUploadResultToOutcome({ status: 500, aborted: false })).toEqual({
      kind: 'error',
      message: 'Upload failed (500)',
    });
  });
});
