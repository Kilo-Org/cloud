'use client';

import { useQuery } from '@tanstack/react-query';
import { createElement, useEffect } from 'react';

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
    throw new Error(
      payload?.error ??
        (response.status === 503
          ? 'Referral sharing is not configured in this environment.'
          : 'Referral sharing is temporarily unavailable.')
    );
  }

  return { token: payload.token, widgetId: payload.widgetId };
}

function WidgetContent({ state }: { state: WidgetState }) {
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
            <div className="text-muted-foreground text-sm">Loading referral widget…</div>
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
