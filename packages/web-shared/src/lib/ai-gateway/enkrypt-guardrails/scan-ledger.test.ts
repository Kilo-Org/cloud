import { describe, expect, it } from '@jest/globals';
import {
  computeEnkryptScanCharge,
  ENKRYPT_CREDIT_PRICE_MICRODOLLARS,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrails/scan-ledger';

describe('computeEnkryptScanCharge', () => {
  it('charges the reported credits for a successful scan', () => {
    expect(computeEnkryptScanCharge({ httpStatus: 200, creditsCost: 7 }, 'input', 3000)).toEqual({
      enkryptCredits: 7,
      estimated: false,
      costMicrodollars: 7 * ENKRYPT_CREDIT_PRICE_MICRODOLLARS,
    });
  });

  it('estimates credits when the header is missing', () => {
    expect(computeEnkryptScanCharge({ httpStatus: 200, creditsCost: null }, 'input', 3000)).toEqual(
      {
        enkryptCredits: 7,
        estimated: true,
        costMicrodollars: 7 * ENKRYPT_CREDIT_PRICE_MICRODOLLARS,
      }
    );
  });

  it('caps the charge at the documented maximum for the detectors', () => {
    expect(computeEnkryptScanCharge({ httpStatus: 200, creditsCost: 900 }, 'input', 10)).toEqual({
      enkryptCredits: 900,
      estimated: false,
      costMicrodollars: 51 * ENKRYPT_CREDIT_PRICE_MICRODOLLARS,
    });
    expect(
      computeEnkryptScanCharge({ httpStatus: 200, creditsCost: 900 }, 'output', 10).costMicrodollars
    ).toBe(2 * ENKRYPT_CREDIT_PRICE_MICRODOLLARS);
  });

  it.each([402, 500, null])('never charges when the scan did not succeed (%s)', httpStatus => {
    expect(
      computeEnkryptScanCharge({ httpStatus, creditsCost: 3 }, 'input', 10).costMicrodollars
    ).toBe(0);
  });
});
