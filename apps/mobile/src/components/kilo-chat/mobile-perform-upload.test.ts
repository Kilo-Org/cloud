import { describe, expect, it } from 'vitest';

import { mapUploadResultToOutcome } from './mobile-perform-upload';

describe('mapUploadResultToOutcome', () => {
  it('resolves successful 2xx uploads', () => {
    expect(mapUploadResultToOutcome({ status: 200, aborted: false })).toEqual({ kind: 'ok' });
    expect(mapUploadResultToOutcome({ status: 204, aborted: false })).toEqual({ kind: 'ok' });
  });

  it('marks aborted uploads', () => {
    expect(mapUploadResultToOutcome({ status: 0, aborted: true })).toEqual({ kind: 'aborted' });
  });

  it('maps network and HTTP errors', () => {
    expect(mapUploadResultToOutcome({ status: 0, aborted: false })).toEqual({
      kind: 'error',
      message: 'Network error during upload',
    });
    expect(mapUploadResultToOutcome({ status: 403, aborted: false })).toEqual({
      kind: 'error',
      message: 'Upload failed (403)',
    });
  });
});
