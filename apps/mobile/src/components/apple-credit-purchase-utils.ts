import { type AppleCreditDisplayProduct } from '@/lib/apple-iap/types';

export function formatAppleCreditAmount(creditedCents: number): string {
  return `$${(creditedCents / 100).toFixed(2)} credits`;
}

export function getAppleCreditProductButtonText(product: AppleCreditDisplayProduct): string {
  return `${formatAppleCreditAmount(product.creditedCents)} - Pay ${product.localizedPrice}`;
}

export function shouldShowAppleCreditPurchaseEntry(params: {
  platform: string;
  selectedOrgId: string | undefined;
}): boolean {
  return params.platform === 'ios' && params.selectedOrgId === undefined;
}
