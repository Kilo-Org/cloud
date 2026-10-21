'use client';

import { redirect } from 'next/navigation';
import { useEffect } from 'react';
import type { TopUpTransactionSummary } from './actions';
import { fetchTopUpTransactionForStripeSession, getPaymentReturnUrl } from './actions';
import BigLoader from '@/components/BigLoader';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import {
  TOPUP_AMOUNT_QUERY_STRING_KEY,
  TOPUP_STATUS_PENDING,
  TOPUP_STATUS_QUERY_STRING_KEY,
  TOPUP_TRANSACTION_QUERY_STRING_KEY,
} from '@kilocode/web-shared/lib/organizations/constants';
import { PageContainer } from '@/components/layouts/PageContainer';

const MAX_TRANSACTION_LOOKUP_ATTEMPTS = 15;

export function getRedirectUrl(txn: TopUpTransactionSummary | undefined, returnUrl: string | null) {
  if (returnUrl) {
    return returnUrl;
  }

  const params = new URLSearchParams();
  if (!txn) {
    params.set(TOPUP_STATUS_QUERY_STRING_KEY, TOPUP_STATUS_PENDING);
    return `/credits?${params.toString()}`;
  }
  if (!txn.organizationId) {
    params.set(TOPUP_TRANSACTION_QUERY_STRING_KEY, txn.id);
    return `/credits?${params.toString()}`;
  }
  params.set(TOPUP_AMOUNT_QUERY_STRING_KEY, fromMicrodollars(txn.amountMicrodollars).toString());
  return `/organizations/${txn.organizationId}?${params.toString()}`;
}

export default function TopUpSuccessPage() {
  useEffect(() => {
    let cancelled = false;

    const processPayment = async () => {
      const searchParams = new URLSearchParams(window.location.search);
      const sessionId = searchParams.get('session_id') ?? '';
      const returnUrlPromise = getPaymentReturnUrl().catch(() => null);
      const findCreditTransaction = async (
        attempt: number
      ): Promise<TopUpTransactionSummary | undefined> => {
        if (attempt >= MAX_TRANSACTION_LOOKUP_ATTEMPTS || cancelled) return undefined;

        await new Promise(resolve => setTimeout(resolve, attempt * 100));
        if (cancelled) return undefined;

        console.info(`Attempt ${attempt + 1} to fetch credit transaction ID`);
        const result = await fetchTopUpTransactionForStripeSession(sessionId);
        if (result.status === 'found') return result.transaction;
        // The checkout cannot be resolved for this caller, so another attempt
        // repeats the same answer.
        if (result.status === 'unavailable') return undefined;
        return findCreditTransaction(attempt + 1);
      };

      const [creditTransaction, returnUrl] = await Promise.all([
        findCreditTransaction(0),
        returnUrlPromise,
      ]);
      if (cancelled) return;

      if (searchParams.get('origin') === 'extension') {
        redirect('/sign-in-to-editor?path=profile');
      }
      redirect(getRedirectUrl(creditTransaction, returnUrl));
    };

    void processPayment();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageContainer>
      <div className="flex min-h-screen flex-col items-center justify-center gap-12">
        <BigLoader title="Processing Payment" />
      </div>
    </PageContainer>
  );
}
