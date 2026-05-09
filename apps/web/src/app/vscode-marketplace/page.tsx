'use client';

import { useEffect } from 'react';
import { usePostHog } from 'posthog-js/react';

const REDIRECT_URL = 'https://marketplace.visualstudio.com/items?itemName=kilocode.kilo-code';

export default function VSCodeMarketplaceRedirectPage() {
  const posthog = usePostHog();

  useEffect(() => {
    const performRedirect = () => {
      window.location.href = REDIRECT_URL;
    };

    // Posthog Bug workaround: posthog.capture() is not working without a timeout
    const captureTimeout = setTimeout(() => {
      posthog?.capture('vscode_marketplace_redirect', {
        source: 'vscode-marketplace-page',
      });
    }, 0); // Capture event immediately

    const redirectTimeout = setTimeout(() => {
      performRedirect();
    }, 500);

    return () => {
      clearTimeout(captureTimeout);
      clearTimeout(redirectTimeout);
    };
  }, [posthog]);

  // Optionally, render a fallback/loading state
  return <div style={{ textAlign: 'center', marginTop: '2rem' }}>Redirecting…</div>;
}
