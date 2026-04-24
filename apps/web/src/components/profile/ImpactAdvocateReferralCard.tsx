'use client';

import { createElement, useEffect, useState } from 'react';
import { Gift } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type WidgetState =
  | { status: 'loading' }
  | { status: 'ready'; token: string; widgetId: string }
  | { status: 'unavailable'; message: string };

export function ImpactAdvocateReferralCard() {
  const [state, setState] = useState<WidgetState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

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

        setState({
          status: 'unavailable',
          message: error instanceof Error ? error.message : 'Failed to load referral sharing.',
        });
      }
    };

    void loadWidgetToken();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card className="w-full text-left">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gift className="h-5 w-5" />
          Referral Program
        </CardTitle>
        <CardDescription>
          Invite a friend to KiloClaw. When they become an eligible paid personal subscriber, you
          both get a free month.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === 'loading' ? (
          <div className="text-muted-foreground text-sm">Loading referral sharing…</div>
        ) : state.status === 'unavailable' ? (
          <div className="text-muted-foreground text-sm">{state.message}</div>
        ) : (
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
        )}
      </CardContent>
    </Card>
  );
}
