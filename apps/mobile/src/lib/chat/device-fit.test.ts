import { describe, expect, it } from 'vitest';

import { deviceFit, maxParametersFor, parameterFit } from './device-fit';

const GIB = 1024 ** 3;
const roomy = { memoryBytes: 8 * GIB, freeBytes: 64 * GIB };

describe('device fit', () => {
  it('rates a download by the memory it needs on this device', () => {
    expect(deviceFit(0.5 * GIB, roomy)).toBe('fits');
    expect(deviceFit(4 * GIB, roomy)).toBe('tight');
    expect(deviceFit(6 * GIB, roomy)).toBe('tooLarge');
  });

  it('says when storage, not memory, is the limit', () => {
    expect(deviceFit(0.5 * GIB, { memoryBytes: 8 * GIB, freeBytes: 0.8 * GIB })).toBe('noStorage');
  });

  it('judges nothing on memory the platform does not report', () => {
    expect(deviceFit(0.5 * GIB, { memoryBytes: null, freeBytes: 64 * GIB })).toBeUndefined();
  });

  it('limits the fitting list to models that fit at least tightly', () => {
    const limit = maxParametersFor(roomy.memoryBytes);
    expect(parameterFit(limit * 0.99, roomy)).toBe('tight');
    expect(parameterFit(limit * 1.1, roomy)).toBe('tooLarge');
    expect(parameterFit(1e9, roomy)).toBe('fits');
  });
});
