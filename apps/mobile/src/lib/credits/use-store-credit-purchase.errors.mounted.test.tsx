/**
 * The inline purchase-error owner suppresses the toast a screen behind it
 * would otherwise pop for the same failure. The suppression is a mount
 * counter, not a flag, because more than one owner can be mounted at once
 * (the purchase screen and its sheet); a boolean would unsuppress the moment
 * the first one unmounted and toast behind the second.
 */

import { createElement } from 'react';
import { toast } from 'sonner-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import {
  CREDIT_PURCHASE_FAILED_KEY,
  resetInlinePurchaseErrorOwnership,
  resetPurchaseErrorToastDedup,
  showDedupedPurchaseError,
  useInlinePurchaseErrorOwnership,
} from './use-store-credit-purchase';

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('expo-iap', () => ({
  ErrorCode: {
    AlreadyOwned: 'already-owned',
    BillingUnavailable: 'billing-unavailable',
    DeferredPayment: 'deferred-payment',
    NotPrepared: 'not-prepared',
    Pending: 'pending',
    UserCancelled: 'user-cancelled',
  },
}));

function InlineErrorOwner() {
  useInlinePurchaseErrorOwnership();
  return null;
}

async function mountInlineErrorOwner() {
  const mounted = await renderWithProviders(createElement(InlineErrorOwner));
  return mounted.unmount;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPurchaseErrorToastDedup();
  resetInlinePurchaseErrorOwnership();
});

describe('useInlinePurchaseErrorOwnership', () => {
  it('suppresses the toast while an inline error owner is mounted', async () => {
    const unmount = await mountInlineErrorOwner();
    try {
      showDedupedPurchaseError(CREDIT_PURCHASE_FAILED_KEY);

      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('toasts the failure once no inline error owner is mounted', async () => {
    const unmount = await mountInlineErrorOwner();
    showDedupedPurchaseError(CREDIT_PURCHASE_FAILED_KEY);
    expect(toast.error).not.toHaveBeenCalled();

    unmount();
    showDedupedPurchaseError(CREDIT_PURCHASE_FAILED_KEY);

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(CREDIT_PURCHASE_FAILED_KEY);
  });

  it('keeps the toast suppressed until every mounted owner has unmounted', async () => {
    const unmountFirst = await mountInlineErrorOwner();
    const unmountSecond = await mountInlineErrorOwner();
    try {
      showDedupedPurchaseError(CREDIT_PURCHASE_FAILED_KEY);
      expect(toast.error).not.toHaveBeenCalled();

      // One owner leaves; the other still renders the failure inline.
      unmountFirst();
      showDedupedPurchaseError(CREDIT_PURCHASE_FAILED_KEY);
      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      unmountSecond();
    }

    showDedupedPurchaseError(CREDIT_PURCHASE_FAILED_KEY);

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(CREDIT_PURCHASE_FAILED_KEY);
  });
});
