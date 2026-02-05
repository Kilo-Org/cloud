'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PaymentMethodStatusBadge } from '@/components/admin/PaymentMethodStatusBadge';
import { UserStatusBadge } from '@/components/admin/UserStatusBadge';
import { CopyTextButton } from '@/components/admin/CopyEmailButton';
import { formatDate } from '@/lib/admin-utils';
import type { UserDetailProps } from '@/types/admin';
import ResetAPIKeyButton from './ResetAPIKeyButton';
import ResetToMagicLinkLoginButton from './ResetToMagicLinkLoginButton';
import CheckKiloPassButton from './CheckKiloPassButton';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { Webhook } from 'lucide-react';

type UserAdminAccountInfoProps = UserDetailProps;

export function UserAdminAccountInfo(user: UserAdminAccountInfoProps) {
  return (
    <Card
      className={`flex-1 ${user.blocked_reason || user.is_blacklisted_by_domain ? 'border-red-500 bg-red-950/50' : ''}`}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex min-w-max items-center gap-4">
            <img
              src={user.google_user_image_url}
              alt={user.google_user_name}
              className="h-16 w-16 rounded-full"
              onError={e => {
                const target = e.target as HTMLImageElement;
                target.src = '/default-avatar.svg';
              }}
            />
            <div>
              <CardTitle className="text-2xl">{user.google_user_name}</CardTitle>
              <div className="flex items-center gap-2">
                <CardDescription className="text-lg">{user.google_user_email}</CardDescription>
                <CopyTextButton text={user.google_user_email} />
              </div>
            </div>
          </div>
          <div className="ml-auto flex min-w-min shrink flex-wrap items-center gap-2">
            <UserStatusBadge is_detail={true} user={user} />
            <PaymentMethodStatusBadge paymentMethodStatus={user.paymentMethodStatus} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-row-reverse flex-wrap justify-between gap-6">
          <div className="flex grow basis-auto flex-col items-end space-y-2">
            <ResetAPIKeyButton userId={user.id} />
            {!user.is_sso_protected_domain && <ResetToMagicLinkLoginButton userId={user.id} />}
            <CheckKiloPassButton userId={user.id} />
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/users/${encodeURIComponent(user.id)}/heuristic-abuse`}>
                View usage + abuse
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/users/${encodeURIComponent(user.id)}/webhooks`}>
                <Webhook className="mr-2 h-4 w-4" />
                View webhooks
              </Link>
            </Button>
          </div>
          <div className="grow basis-auto space-y-4">
            <div>
              <h4 className="text-muted-foreground text-sm font-medium">Updated At</h4>
              <p>{formatDate(user.updated_at)}</p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-sm font-medium">Hosted Domain</h4>
              <p>
                {user.hosted_domain || 'N/A'}{' '}
                {user.hosted_domain && <CopyTextButton text={user.hosted_domain} />}
              </p>
            </div>
          </div>
          <div className="grow basis-auto space-y-4">
            <div>
              <h4 className="text-muted-foreground text-sm font-medium">User ID</h4>
              <p className="font-mono text-sm break-all">
                {user.id} <CopyTextButton text={user.id} />
              </p>
            </div>
            <div>
              <h4 className="text-muted-foreground text-sm font-medium">Email</h4>
              <div className="flex items-center gap-2">
                <p className="break-all">{user.google_user_email}</p>
                <CopyTextButton text={user.google_user_email} />
              </div>
            </div>
            <div>
              <h4 className="text-muted-foreground text-sm font-medium">Created At</h4>
              <p>{formatDate(user.created_at)}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
