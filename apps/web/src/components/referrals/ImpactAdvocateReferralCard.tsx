'use client';

import { createElement, useEffect, useState } from 'react';

type WidgetState =
  | { status: 'loading' }
  | { status: 'ready'; token: string; widgetId: string }
  | { status: 'unavailable'; message: string };

function renderWidgetContent(state: WidgetState) {
  switch (state.status) {
    case 'loading':
      return <div className="text-muted-foreground text-sm">Loading referral sharing…</div>;
    case 'unavailable':
      return <div className="text-muted-foreground text-sm">{state.message}</div>;
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

export function ImpactAdvocateReferralWidget() {
  const [state, setState] = useState<WidgetState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    delete window.impactToken;

    const loadWidgetToken = async () => {
      try {
        const response = await fetch('/api/impact-advocate/token', {
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

        if (cancelled) {
          return;
        }

        if (!response.ok || !payload?.token || !payload.widgetId) {
          delete window.impactToken;
          setState({
            status: 'unavailable',
            message:
              payload?.error ??
              (response.status === 503
                ? 'Referral sharing is not configured in this environment.'
                : 'Referral sharing is temporarily unavailable.'),
          });
          return;
        }

        window.impactToken = payload.token;
        setState({
          status: 'ready',
          token: payload.token,
          widgetId: payload.widgetId,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        delete window.impactToken;
        setState({
          status: 'unavailable',
          message: error instanceof Error ? error.message : 'Failed to load referral sharing.',
        });
      }
    };

    void loadWidgetToken();

    return () => {
      cancelled = true;
      delete window.impactToken;
    };
  }, []);

  return <div className="w-full">{renderWidgetContent(state)}</div>;
}
