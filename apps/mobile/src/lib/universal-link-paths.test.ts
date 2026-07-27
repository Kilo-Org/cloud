import { androidPathPatterns } from '@kilocode/app-shared/universal-links';
import { describe, expect, it } from 'vitest';

import { UNIVERSAL_LINK_PATH_PATTERNS } from './universal-link-paths.js';

describe('UNIVERSAL_LINK_PATH_PATTERNS', () => {
  it('deep-equals androidPathPatterns() from @kilocode/app-shared/universal-links', () => {
    expect(UNIVERSAL_LINK_PATH_PATTERNS).toEqual(androidPathPatterns());
  });
});
