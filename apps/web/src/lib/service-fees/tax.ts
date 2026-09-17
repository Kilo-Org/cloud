import 'server-only';

import type Stripe from 'stripe';

export type ServiceFeeTaxBehavior = Extract<Stripe.Price.TaxBehavior, 'exclusive' | 'inclusive'>;

export type ServiceFeeTaxPrincipal = { kind: 'inline' } | { kind: 'price'; priceId: string };

export type ServiceFeeTaxInput = {
  source: 'inline_inherit' | 'price';
  taxBehavior?: ServiceFeeTaxBehavior;
};

export type StripePriceTaxReader = {
  prices: {
    retrieve(
      id: string,
      params?: Stripe.PriceRetrieveParams
    ): Promise<Pick<Stripe.Price, 'id' | 'tax_behavior'>>;
  };
};

/**
 * Inline principal lines omit `tax_behavior`. A fee line built the same way
 * inherits identical treatment without retrieving a Price.
 */
export function buildInheritedInlineServiceFeeTaxInput(): ServiceFeeTaxInput {
  return { source: 'inline_inherit' };
}

export async function readServiceFeeTaxBehaviorFromPrice(params: {
  stripe: StripePriceTaxReader;
  priceId: string;
}): Promise<ServiceFeeTaxInput> {
  const price = await params.stripe.prices.retrieve(params.priceId);
  if (price.tax_behavior !== 'exclusive' && price.tax_behavior !== 'inclusive') {
    throw new Error('service_fee_tax_behavior_unresolved');
  }
  return {
    source: 'price',
    taxBehavior: price.tax_behavior,
  };
}

/**
 * Finance/tax treatment was confirmed on 2026-08-11: the service-fee line
 * follows the eligible product's Stripe tax behavior. Inline fee lines inherit
 * treatment; Price-based fee lines mirror an explicit inclusive/exclusive value.
 */
export async function resolveServiceFeeTaxInput(params: {
  principal: ServiceFeeTaxPrincipal;
  stripe?: StripePriceTaxReader;
}): Promise<ServiceFeeTaxInput> {
  if (params.principal.kind === 'inline') {
    return buildInheritedInlineServiceFeeTaxInput();
  }
  if (!params.stripe) {
    throw new Error('service_fee_tax_behavior_unresolved');
  }
  return readServiceFeeTaxBehaviorFromPrice({
    stripe: params.stripe,
    priceId: params.principal.priceId,
  });
}
