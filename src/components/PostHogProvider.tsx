'use client';

import posthog from 'posthog-js';
import { PostHogProvider as PHProvider, usePostHog } from 'posthog-js/react';
import { useSession } from 'next-auth/react';
import { Suspense, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const isProduction = process.env.NODE_ENV === 'production';

    if (!key) {
      console.error('PostHog Disabled! - PostHog key is not defined');
      return;
    }

    // Use a fake token for non-production environments as recommended by PostHog
    const token = isProduction ? key : 'fake-token';

    posthog.init(token, {
      api_host: '/ingest',
      ui_host: 'https://us.posthog.com',
      disable_web_experiments: false,
      capture_pageview: false, // We capture pageviews manually
      capture_pageleave: true, // Enable pageleave capture
      loaded: function (ph) {
        if (!isProduction) {
          // Opt out of capturing in non-production environments
          ph.opt_out_capturing();
          ph.set_config({ disable_session_recording: true });
          console.log('PostHog capturing disabled in non-production environment');
        }
      },
    });
    window.posthog = posthog; // Reveal PostHog object globally
    if (process.env.NEXT_PUBLIC_POSTHOG_DEBUG) {
      posthog.debug(true);
    } else if (localStorage.getItem('ph_debug')) {
      posthog.debug(false);
    }
  }, []);

  return (
    <PHProvider client={posthog}>
      <IdentifyUser />
      <SuspendedPostHogPageView />
      {children}
    </PHProvider>
  );
}

function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const posthog = usePostHog();

  useEffect(() => {
    if (pathname && posthog) {
      let url = window.origin + pathname;
      const search = searchParams.toString();
      if (search) {
        url += '?' + search;
      }
      posthog.capture('$pageview', { $current_url: url });
    }
  }, [pathname, searchParams, posthog]);

  return null;
}

function SuspendedPostHogPageView() {
  return (
    <Suspense fallback={null}>
      <PostHogPageView />
    </Suspense>
  );
}

function IdentifyUser() {
  const posthog = usePostHog();
  const { data: session, status } = useSession();
  const previousStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Check if posthog is loaded before using it
    if (!posthog || !posthog.__loaded) return;

    const previousStatus = previousStatusRef.current;

    if (status === 'authenticated' && session?.user?.email) {
      const currentAnonymousId = posthog.get_distinct_id();
      posthog.identify(session.user.email, {
        email: session.user.email,
        name: session.user.name,
      });
      // Alias the new user ID (session.user.email) to the previous anonymous ID.
      // This links pre-login events to the identified user.
      // Important: Only call alias if currentAnonymousId is different from session.user.email
      // to avoid aliasing an ID to itself.
      if (currentAnonymousId && currentAnonymousId !== session.user.email) {
        posthog.alias(session.user.email, currentAnonymousId);
      }
      // Re-fetch feature flags now that the user is identified.
      // Without this, flags evaluated for the anonymous ID remain cached,
      // so user-targeted flags (e.g. kiloclaw) would stay false until
      // the next natural reload.
      posthog.reloadFeatureFlags();
    } else if (status === 'unauthenticated' && previousStatus === 'authenticated') {
      // Reset PostHog identification only when transitioning from authenticated to unauthenticated (logout)
      posthog.reset();
    }

    // Update the previous status for the next render
    previousStatusRef.current = status;
  }, [session, status, posthog]); // Rerun effect if session, status, or posthog instance changes

  return null; // This component doesn't render anything
}
