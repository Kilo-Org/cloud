'use client';

import { useState, Fragment } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { parseISO, format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Copy } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatDollars, getInitialsFromName } from '@/lib/utils';
import type { AdminUserReferralsResponse } from '@/app/admin/api/users/[id]/referrals/route';

type Props = {
  kilo_user_id: string;
  className?: string;
};

export function UserAdminReferrals({ kilo_user_id, className }: Props) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-user-referrals', kilo_user_id],
    queryFn: async (): Promise<AdminUserReferralsResponse> => {
      const response = await fetch(
        `/admin/api/users/${encodeURIComponent(kilo_user_id)}/referrals`
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: 'Failed' }));
        const message =
          typeof payload?.error === 'string' ? payload.error : 'Failed to fetch referrals';
        throw new Error(message);
      }
      const payload: AdminUserReferralsResponse = await response.json();
      return payload;
    },
  });

  const [copied, setCopied] = useState<{ kind: 'code' | 'url' | null; at: number | null }>({
    kind: null,
    at: null,
  });

  const doCopy = async (text: string, kind: 'code' | 'url') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ kind, at: Date.now() });
      window.setTimeout(() => setCopied({ kind: null, at: null }), 1500);
    } catch {
      // Copy is a convenience; failure is non-fatal
    }
  };

  const renderReferrerSection = () => {
    const referrers = data?.referrers ?? [];

    if (referrers.length === 0) {
      return (
        <h4 className="text-muted-foreground mb-2 text-sm font-medium">
          User was not referred by anybody.
        </h4>
      );
    }

    return (
      <>
        <h4 className="text-muted-foreground mb-1 text-sm font-medium">Referred by</h4>
        {referrers.map(r => (
          <div key={`${r.id}`}>
            <Link
              href={`/admin/users/${encodeURIComponent(r.id)}`}
              aria-label={`View admin details for ${r.name} (${r.email})`}
              className="truncate text-sm text-blue-600 underline hover:text-blue-800"
            >
              {r.name + ' (' + r.email + ')'}
            </Link>{' '}
            <span className="text-muted-foreground text-xs">
              {format(parseISO(r.created_at), 'yyyy-MM-dd HH:mm')}
            </span>
          </div>
        ))}
      </>
    );
  };

  const renderReferredUsersSection = () => {
    const users = data?.referredUsers ?? [];

    return (
      <>
        <h4 className="text-muted-foreground my-2 text-sm font-medium">
          User referred {users.length} other users
        </h4>
        <div className="bg-muted/50 grid max-w-max grid-cols-[max-content_minmax(5em,auto)_minmax(max-content,auto)_auto] items-baseline gap-2 rounded-md border p-2 text-sm empty:hidden">
          <span className="col-span-2 text-center font-bold">User</span>
          <span className="text-center font-bold">referred on</span>
          <span className="text-center font-bold">redeemed at</span>
          {users.map(u => (
            <Fragment key={u.id}>
              <Avatar className="row-span-2 h-6 w-6 self-center">
                <AvatarImage src={u.google_user_image_url} alt={u.name} />
                <AvatarFallback>{getInitialsFromName(u.name)}</AvatarFallback>
              </Avatar>
              <Link
                href={`/admin/users/${encodeURIComponent(u.id)}`}
                aria-label={`View admin details for ${u.name} (${u.email})`}
                className="truncate text-blue-600 underline hover:text-blue-800"
              >
                {u.name}
              </Link>
              <div className="text-muted-foreground row-span-2">
                {format(parseISO(u.created_at), 'yyyy-MM-dd HH:mm')}
              </div>
              <div className="text-foreground row-span-2">
                {u.paid_at && (
                  <>
                    {u.amount_usd && `${formatDollars(u.amount_usd)} on `}
                    <span className="truncate text-nowrap">
                      {format(parseISO(u.paid_at), 'yyyy-MM-dd HH:mm')}
                    </span>
                  </>
                )}
              </div>
              <div className="truncate">{u.email}</div>
            </Fragment>
          ))}
        </div>
      </>
    );
  };

  return (
    <Card className={`max-h-max lg:col-span-2 ${className ?? ''}`}>
      <CardHeader>
        <CardTitle>Referrals</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-600">Failed to load referrals</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">Loading referrals...</p>
        ) : (
          <div>
            <h4 className="text-muted-foreground text-sm font-medium">Referral code</h4>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="font-mono text-sm">{data?.code?.code}</span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => doCopy(data?.code?.code ?? '', 'code')}
                aria-label="Copy referral code"
                title="Copy referral code"
              >
                <Copy className="h-4 w-4" />
              </Button>
              <span className="text-muted-foreground text-xs">
                {copied.kind === 'code'
                  ? 'Copied'
                  : `Max redemptions: ${data?.code?.maxRedemptions}`}
              </span>
            </div>
            {renderReferrerSection()}
            {renderReferredUsersSection()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
