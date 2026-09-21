import { describe, expect, it } from 'vitest';

import { getFilename } from './tool-card-utils';

describe('getFilename', () => {
  it('returns the last path segment', () => {
    expect(getFilename('/workspace/project/report.pdf')).toBe('report.pdf');
    expect(getFilename('readme.txt')).toBe('readme.txt');
  });

  it('returns the input when there is no slash', () => {
    expect(getFilename('plain-name')).toBe('plain-name');
  });
});
