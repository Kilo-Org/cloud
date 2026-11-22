/**
 * Guards that the cross-app flag keys have exactly one literal source. The
 * type-level cases (the exhaustive map and the incomplete one) are checked by
 * `pnpm typecheck`, whose tsconfig includes every TypeScript file; the runtime
 * assertions only keep the file meaningful to vitest.
 */
import { describe, expect, it } from 'vitest';

import {
  CHATGPT_ACCESS_FLAG,
  CODE_REVIEW_COUNCIL_FLAG,
  CODE_REVIEW_MD_CONVERSION_FLAG,
  CROSS_APP_FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  ORGANIZATION_AUTO_MODEL_FLAG,
} from './feature-flags';

// The object the constants must alias. The short name keeps each assertion on a
// single line.
const KEYS = CROSS_APP_FEATURE_FLAG_KEYS;

const FLAG_CONSTANTS = [
  CHATGPT_ACCESS_FLAG,
  CODE_REVIEW_COUNCIL_FLAG,
  CODE_REVIEW_MD_CONVERSION_FLAG,
  ORGANIZATION_AUTO_MODEL_FLAG,
];

describe('cross-app feature flags', () => {
  it('aliases each constant to its canonical member', () => {
    expect(Object.is(CODE_REVIEW_MD_CONVERSION_FLAG, KEYS.codeReviewMdConversion)).toBe(true);
    expect(Object.is(CODE_REVIEW_COUNCIL_FLAG, KEYS.codeReviewCouncil)).toBe(true);
    expect(Object.is(ORGANIZATION_AUTO_MODEL_FLAG, KEYS.organizationAutoModel)).toBe(true);
    expect(Object.is(CHATGPT_ACCESS_FLAG, KEYS.chatGptSignIn)).toBe(true);
  });

  it('names exactly the values of the key object, once each', () => {
    const objectKeys = Object.values(KEYS);

    expect([...FLAG_CONSTANTS].sort()).toEqual([...objectKeys].sort());
    // A repeated value would leave the object with fewer distinct keys than the
    // four constants the apps import.
    expect(new Set(objectKeys).size).toBe(objectKeys.length);
  });

  it('maps every key', () => {
    const enabled: Record<FeatureFlagKey, true> = {
      [CODE_REVIEW_MD_CONVERSION_FLAG]: true,
      [CODE_REVIEW_COUNCIL_FLAG]: true,
      [ORGANIZATION_AUTO_MODEL_FLAG]: true,
      [CHATGPT_ACCESS_FLAG]: true,
    };

    expect(Object.keys(enabled).sort()).toEqual([...FLAG_CONSTANTS].sort());
  });

  it('rejects a map that omits a key', () => {
    // @ts-expect-error the map leaves a key of FeatureFlagKey unset
    const incomplete: Record<FeatureFlagKey, true> = {
      [CODE_REVIEW_MD_CONVERSION_FLAG]: true,
      [CODE_REVIEW_COUNCIL_FLAG]: true,
      [ORGANIZATION_AUTO_MODEL_FLAG]: true,
    };

    expect(Object.keys(incomplete)).toHaveLength(FLAG_CONSTANTS.length - 1);
  });
});
