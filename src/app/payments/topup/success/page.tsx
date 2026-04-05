'use client';

import type { CreditTransaction } from '@kilocode/db/schema';
import { redirect } from 'next/navigation';
import { useEffect, useState } from 'react';
import { fetchCreditTransactionIdForStripeSession, getPaymentReturnUrl } from './actions';
import BigLoader from '@/components/BigLoader';
import { captureMessage } from '@sentry/nextjs';
import { fromMicrodollars } from '@/lib/utils';
import { TOPUP_AMOUNT_QUERY_STRING_KEY } from '@/lib/organizations/constants';
import { PageContainer } from '@/components/layouts/PageContainer';

function getRedirectUrl(txn: CreditTransaction | undefined, returnUrl: string | null) {
  // If there's a valid return URL from the cookie, use it
  if (returnUrl) {
    return returnUrl;
  }

  // Otherwise, use the existing logic
  if (!txn || !txn.organization_id) {
    return '/payments/topup/thank-you';
  }
  const params = new URLSearchParams();
  params.set(TOPUP_AMOUNT_QUERY_STRING_KEY, fromMicrodollars(txn.amount_microdollars).toString());
  return `/organizations/${txn.organization_id}?${params.toString()}`;
}

export default function TopUpSuccessPage() {
  const [creditTransaction, setCreditTransaction] = useState<CreditTransaction>();
  const [tries, setTries] = useState(0);
  const [hasExceededMaxTries, setHasExceededMaxTries] = useState(false);
  const [returnUrl, setReturnUrl] = useState<string | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const sessionId = searchParams.get('session_id') as string;

    // we intententionally listen to tries because we want to set a timeout after each try
    if (tries > 14) {
      setHasExceededMaxTries(true);
      void (async function () {
        captureMessage('Exceeded max tries to fetch credit transaction ID', {
          extra: {
            sessionId: sessionId,
          },
        });
      })();

      return;
    }

    const timeoutId = setTimeout(async function () {
      console.info(`Attempt ${tries + 1} to fetch credit transaction ID`);
      console.info(searchParams, sessionId);

      const transaction = await fetchCreditTransactionIdForStripeSession(sessionId);

      if (transaction) {
        setCreditTransaction(transaction);
      } else {
        setTries(prev => prev + 1);
      }
    }, tries * 100);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [tries]);

  // Fetch the return URL from the cookie on mount
  useEffect(() => {
    void (async function () {
      const url = await getPaymentReturnUrl();
      setReturnUrl(url);
    })();
  }, []);

  useEffect(() => {
    if (creditTransaction || hasExceededMaxTries) {
      const searchParams = new URLSearchParams(window.location.search);
      const origin = searchParams.get('origin') as string;
      if (origin === 'extension') {
        redirect(`/sign-in-to-editor?path=profile`);
      } else {
        const redirectUrl = getRedirectUrl(creditTransaction, returnUrl);
        redirect(redirectUrl);
      }
    }
  }, [creditTransaction, hasExceededMaxTries, returnUrl]);

  return (
    <PageContainer>
      <div className="flex min-h-screen flex-col items-center justify-center gap-12">
        <BigLoader title="Processing Payment" />
        {creditTransaction?.id}
      </div>
    </PageContainer>
  );
}
