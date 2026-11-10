import { describe, expect, it } from 'vitest';

import { NativeDownloadProgress } from './native-transfer-progress';

describe('NativeDownloadProgress', () => {
  it('reads the bigint byte counts iOS sends as numbers', () => {
    expect(NativeDownloadProgress.parse({ bytesWritten: 400n, totalBytes: 1000n })).toEqual({
      bytesWritten: 400,
      totalBytes: 1000,
    });
  });

  it('keeps the number byte counts Android sends', () => {
    expect(NativeDownloadProgress.parse({ bytesWritten: 400, totalBytes: -1 })).toEqual({
      bytesWritten: 400,
      totalBytes: -1,
    });
  });
});
