export type ImpactAdvocateReferralProduct = 'kiloclaw' | 'kilo_pass';

export function buildImpactAdvocateTokenUrl(product: ImpactAdvocateReferralProduct = 'kiloclaw') {
  if (product === 'kiloclaw') return '/api/impact-advocate/token';
  return `/api/impact-advocate/token?product=${encodeURIComponent(product)}`;
}
