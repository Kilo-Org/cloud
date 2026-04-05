'use client';

import { useQuery } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

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
    <Alert variant="warning" className="mb-4 border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
      <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-800 dark:text-amber-200">Viewing as admin</AlertTitle>
      <AlertDescription className="text-amber-700 dark:text-amber-300">
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
      </AlertDescription>
    </Alert>
  );
}
