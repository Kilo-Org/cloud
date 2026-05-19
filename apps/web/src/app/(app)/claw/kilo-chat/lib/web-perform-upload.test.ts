import { mapXhrResultToOutcome } from './web-perform-upload';

describe('mapXhrResultToOutcome', () => {
  it('resolves on a 2xx status', () => {
    expect(mapXhrResultToOutcome({ status: 200, aborted: false })).toEqual({ kind: 'ok' });
    expect(mapXhrResultToOutcome({ status: 204, aborted: false })).toEqual({ kind: 'ok' });
  });

  it('marks aborted regardless of status', () => {
    expect(mapXhrResultToOutcome({ status: 0, aborted: true })).toEqual({ kind: 'aborted' });
    expect(mapXhrResultToOutcome({ status: 200, aborted: true })).toEqual({ kind: 'aborted' });
  });

  it('returns an error for non-2xx', () => {
    expect(mapXhrResultToOutcome({ status: 403, aborted: false })).toEqual({
      kind: 'error',
      message: 'Upload failed (403)',
    });
    expect(mapXhrResultToOutcome({ status: 500, aborted: false })).toEqual({
      kind: 'error',
      message: 'Upload failed (500)',
    });
  });

  it('reports network error when status is 0 and not aborted', () => {
    expect(mapXhrResultToOutcome({ status: 0, aborted: false })).toEqual({
      kind: 'error',
      message: 'Network error during upload',
    });
  });
});
