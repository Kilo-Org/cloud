import { metadata as sharedSessionMetadata } from './layout';
import { metadata as legacyShareMetadata } from '../share/layout';

describe('public share page metadata', () => {
  it('excludes current and legacy share pages from indexing', () => {
    expect(sharedSessionMetadata.robots).toEqual({ index: false, follow: false });
    expect(legacyShareMetadata.robots).toEqual({ index: false, follow: false });
  });
});
