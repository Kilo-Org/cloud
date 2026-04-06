'use client';

import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { ShieldAlert } from 'lucide-react';
import { Banner } from '@/components/shared/Banner';

/**
 * Banner displayed when a Kilo admin is viewing a town they don't own.
 * Fetches admin access status via the checkAdminAccess tRPC query.
 * Renders nothing for non-admin users or when viewing their own town.
 */
export function AdminViewingBanner({ townId }: { townId: string }) {
  const trpc = useGastownTRPC();
  const { data } = useQuery(trpc.gastown.checkAdminAccess.queryOptions({ townId }));

  if (!data?.isAdminViewing) return null;

  return (
    <Banner color="amber" role="alert" className="mb-4">
      <Banner.Icon>
        <ShieldAlert />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>Viewing as admin</Banner.Title>
        <Banner.Description>
          This town belongs to{' '}
          {data.ownerOrgId ? (
            <>
              org{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/40">
                {data.ownerOrgId}
              </code>
            </>
          ) : data.ownerUserId ? (
            <>
              user{' '}
              <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/40">
                {data.ownerUserId}
              </code>
            </>
          ) : (
            'another user'
          )}
          . Changes to settings and destructive actions are restricted.
        </Banner.Description>
      </Banner.Content>
    </Banner>
  );
}
