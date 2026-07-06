'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import React, { createElement, useEffect, useState } from 'react';

import {
  buildImpactAdvocateTokenUrl,
  type ImpactAdvocateReferralProduct,
} from './ImpactAdvocateReferralCard.utils';

type WidgetToken = {
  token: string;
  widgetId: string;
};

type WidgetState =
  | { status: 'loading' }
  | { status: 'ready'; token: string; widgetId: string }
  | { status: 'unavailable'; message: string };

export const IMPACT_ADVOCATE_WIDGET_LOAD_TIMEOUT_MS = 10_000;

export const IMPACT_ADVOCATE_WIDGET_LOAD_TIMEOUT_MESSAGE =
  'Ad blockers or network filters can block the referral widget from loading. Either allow the blocked domains or turn off the ad blocker or network filters to see the referral widget.';

async function getWidgetToken(product: ImpactAdvocateReferralProduct): Promise<WidgetToken> {
  const response = await fetch(buildImpactAdvocateTokenUrl(product), {
    method: 'GET',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
    },
  });

  const payload = (await response.json().catch(() => null)) as {
    token?: string;
    widgetId?: string;
    error?: string;
  } | null;

  if (!response.ok || !payload?.token || !payload.widgetId) {
    const isKiloPassConfigurationUnavailable = product === 'kilo_pass' && response.status === 503;
    const fallbackMessage = isKiloPassConfigurationUnavailable
      ? 'Kilo Pass referral sharing is unavailable right now. Rewards already earned stay pending and apply automatically when eligible.'
      : response.status === 503
        ? 'Referral sharing is not configured in this environment.'
        : 'Referral sharing is temporarily unavailable.';
    const message = isKiloPassConfigurationUnavailable
      ? fallbackMessage
      : (payload?.error ?? fallbackMessage);

    throw new Error(message);
  }

  return { token: payload.token, widgetId: payload.widgetId };
}

export function WidgetFallbackContent({ hasTimedOut }: { hasTimedOut: boolean }) {
  if (!hasTimedOut) {
    return <div className="text-muted-foreground text-sm">Loading referral widget…</div>;
  }

  return (
    <div
      className="border-status-warning-border bg-status-warning-surface flex gap-3 rounded-lg border p-4"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <AlertTriangle className="text-status-warning-icon mt-0.5 size-4 shrink-0" />
      <div>
        <p className="text-status-warning type-heading">Referral widget did not load</p>
        <p className="text-muted-foreground type-body mt-1">
          {IMPACT_ADVOCATE_WIDGET_LOAD_TIMEOUT_MESSAGE}
        </p>
      </div>
    </div>
  );
}

function ImpactWidgetFallback() {
  const [hasTimedOut, setHasTimedOut] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setHasTimedOut(true);
    }, IMPACT_ADVOCATE_WIDGET_LOAD_TIMEOUT_MS);

    return () => window.clearTimeout(timeoutId);
  }, []);

  return <WidgetFallbackContent hasTimedOut={hasTimedOut} />;
}

export function WidgetContent({ state }: { state: WidgetState }) {
  switch (state.status) {
    case 'loading':
      return (
        <output className="text-muted-foreground block text-sm">Loading referral sharing…</output>
      );
    case 'unavailable':
      return <output className="text-muted-foreground block text-sm">{state.message}</output>;
    case 'ready':
      return (
        <div data-impact-token={state.token ? 'loaded' : 'missing'}>
          {createElement(
            'impact-embed',
            {
              widget: state.widgetId,
              className: 'block min-h-52 w-full',
            },
            <ImpactWidgetFallback />
          )}
        </div>
      );
  }
}

export function ImpactAdvocateReferralWidget({
  product = 'kiloclaw',
}: {
  product?: ImpactAdvocateReferralProduct;
}) {
  const tokenQuery = useQuery({
    queryKey: ['impact-advocate-widget-token', product],
    queryFn: () => getWidgetToken(product),
    retry: false,
  });

  useEffect(() => {
    if (tokenQuery.data) {
      window.impactToken = tokenQuery.data.token;
    } else {
      delete window.impactToken;
    }

    return () => {
      delete window.impactToken;
    };
  }, [tokenQuery.data]);

  const state: WidgetState = tokenQuery.isPending
    ? { status: 'loading' }
    : tokenQuery.isError
      ? {
          status: 'unavailable',
          message:
            tokenQuery.error instanceof Error
              ? tokenQuery.error.message
              : 'Failed to load referral sharing.',
        }
      : { status: 'ready', token: tokenQuery.data.token, widgetId: tokenQuery.data.widgetId };

  return (
    <div className="w-full">
      <WidgetContent state={state} />
    </div>
  );
}
