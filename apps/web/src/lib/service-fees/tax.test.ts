import { describe, expect, test, jest } from '@jest/globals';

import {
  buildInheritedInlineServiceFeeTaxInput,
  readServiceFeeTaxBehaviorFromPrice,
  resolveServiceFeeTaxInput,
  type StripePriceTaxReader,
} from '@/lib/service-fees/tax';

function priceReader(retrieve: StripePriceTaxReader['prices']['retrieve']): StripePriceTaxReader {
  return { prices: { retrieve } };
}

describe('service fee tax input', () => {
  test('public resolver inherits inline treatment and mirrors Price tax_behavior', async () => {
    const retrieve = jest.fn<StripePriceTaxReader['prices']['retrieve']>(async id => ({
      id,
      tax_behavior: 'exclusive',
    }));

    await expect(
      resolveServiceFeeTaxInput({
        principal: { kind: 'price', priceId: 'price_1' },
        stripe: priceReader(retrieve),
      })
    ).resolves.toEqual({ source: 'price', taxBehavior: 'exclusive' });
    await expect(resolveServiceFeeTaxInput({ principal: { kind: 'inline' } })).resolves.toEqual({
      source: 'inline_inherit',
    });
    expect(retrieve).toHaveBeenCalledWith('price_1');
  });

  test('Price-based resolution requires a Stripe reader', async () => {
    await expect(
      resolveServiceFeeTaxInput({ principal: { kind: 'price', priceId: 'price_1' } })
    ).rejects.toThrow('service_fee_tax_behavior_unresolved');
  });

  test('inline helper represents inherited treatment without Price retrieval', () => {
    expect(buildInheritedInlineServiceFeeTaxInput()).toEqual({ source: 'inline_inherit' });
  });

  test('price helper mirrors exclusive and inclusive tax_behavior', async () => {
    await expect(
      readServiceFeeTaxBehaviorFromPrice({
        stripe: priceReader(async () => ({ id: 'price_1', tax_behavior: 'exclusive' })),
        priceId: 'price_1',
      })
    ).resolves.toEqual({ source: 'price', taxBehavior: 'exclusive' });

    await expect(
      readServiceFeeTaxBehaviorFromPrice({
        stripe: priceReader(async () => ({ id: 'price_2', tax_behavior: 'inclusive' })),
        priceId: 'price_2',
      })
    ).resolves.toEqual({ source: 'price', taxBehavior: 'inclusive' });
  });

  test('price helper rejects unspecified behavior and propagates retrieval failure', async () => {
    await expect(
      readServiceFeeTaxBehaviorFromPrice({
        stripe: priceReader(async () => ({ id: 'price_2', tax_behavior: 'unspecified' })),
        priceId: 'price_2',
      })
    ).rejects.toThrow('service_fee_tax_behavior_unresolved');

    await expect(
      readServiceFeeTaxBehaviorFromPrice({
        stripe: priceReader(async () => {
          throw new Error('stripe retrieval failed');
        }),
        priceId: 'price_3',
      })
    ).rejects.toThrow('stripe retrieval failed');
  });
});
