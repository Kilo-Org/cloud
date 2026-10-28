import { describe, expect, it } from 'vitest';

import { deviceFit, fitsDevice, maxParametersFor } from './device-fit';

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

  it('counts only a judged fit as fitting this device', () => {
    expect(fitsDevice('fits')).toBe(true);
    expect(fitsDevice('tight')).toBe(true);
    expect(fitsDevice('tooLarge')).toBe(false);
    expect(fitsDevice('noStorage')).toBe(false);
    expect(fitsDevice(undefined)).toBe(false);
  });

  it('limits the fitting list to models whose Q4_K_M file fits at least tightly', () => {
    const q4Bytes = maxParametersFor(roomy.memoryBytes) * 0.6;
    expect(deviceFit(q4Bytes * 0.99, roomy)).toBe('tight');
    expect(deviceFit(q4Bytes * 1.1, roomy)).toBe('tooLarge');
  });
});
