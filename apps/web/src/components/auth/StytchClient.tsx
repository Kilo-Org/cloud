'use client';

import Script from 'next/script';
import { useEffect, useState } from 'react';
import { captureException } from '@sentry/nextjs';

const telemetryJsUri =
  process.env.NEXT_PUBLIC_STYTCH_PROJECT_ENV === 'test'
    ? 'https://login-test.kilo.ai/telemetry.js'
    : 'https://login.kilo.ai/telemetry.js';

export const StytchClient = ({ children }: React.PropsWithChildren) => {
  const [freshTelemetryId, setFreshTelemetryId] = useState<string | null>(null);

  useEffect(() => {
    if (freshTelemetryId) {
      //SOMEHOW safari is REALLY slow with the redirect via router, so we do a full page reload
      //We don't believe private browsing mode is an issue, but didn't test NON private browsing mode
      //see https://github.com/Kilo-Org/kilocode-backend/issues/1587
      const url = new URL(window.location.href);
      const searchParams = new URLSearchParams(url.search);
      searchParams.set('telemetry_id', freshTelemetryId);
      url.search = searchParams.toString();
      window.location.href = url.href;
    }
  }, [freshTelemetryId]);

  if (freshTelemetryId) return <>{children}</>;

  return (
    <>
      <Script
        id="stytch-telemetry"
        src={telemetryJsUri}
        strategy="afterInteractive"
        onLoad={async () => {
          if (typeof window === 'undefined') return;
          window
            .GetTelemetryID({
              publicToken: process.env.NEXT_PUBLIC_STYTCH_PUBLIC_TOKEN as string,
              submitURL: 'https://auth.kilo.ai/submit',
            })
            .then(setFreshTelemetryId)
            .catch(err => captureException(err));
        }}
      />
      {children}
    </>
  );
};

declare global {
  interface Window {
    GetTelemetryID: (options: { publicToken: string; submitURL?: string }) => Promise<string>;
  }
}
