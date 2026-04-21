'use client';

import { Card, CardContent } from '@/components/ui/card';
import { PaymentMethodStatusBadge } from '@/components/admin/PaymentMethodStatusBadge';
import { UserStatusBadge } from '@/components/admin/UserStatusBadge';
import { CopyTextButton } from '@/components/admin/CopyEmailButton';
import { formatDate } from '@/lib/admin-utils';
import type { UserDetailProps } from '@/types/admin';
import ResetAPIKeyButton from './ResetAPIKeyButton';
import ResetToMagicLinkLoginButton from './ResetToMagicLinkLoginButton';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { SquareArrowOutUpRight, Webhook } from 'lucide-react';
import { createHash } from 'crypto';

function getGravatarUrl(email: string, size: number = 80): string {
  const hash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}

type UserAdminAccountInfoProps = UserDetailProps;

export function UserAdminAccountInfo(user: UserAdminAccountInfoProps) {
  const gravatarUrl = getGravatarUrl(user.google_user_email);
  const stripeUrl = `https://dashboard.stripe.com/${process.env.NODE_ENV === 'development' ? 'test/' : ''}customers/${user.stripe_customer_id}`;
  const hibpUrl = `https://haveibeenpwned.com/account/${encodeURIComponent(user.google_user_email)}`;

  return (
    <Card
      className={
        user.blocked_reason || user.is_blacklisted_by_domain ? 'border-red-500 bg-red-950/50' : ''
      }
    >
      <CardContent className="pt-5">
        {/* Top row: identity + badges/actions */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src={user.google_user_image_url}
              alt={user.google_user_name}
              className="h-12 w-12 rounded-full"
              onError={e => {
                const target = e.target as HTMLImageElement;
                target.src = '/default-avatar.svg';
              }}
            />
            <div>
              <h2 className="text-lg font-semibold leading-tight">{user.google_user_name}</h2>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground text-sm">{user.google_user_email}</span>
                <CopyTextButton text={user.google_user_email} />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <UserStatusBadge is_detail={true} user={user} />
            <PaymentMethodStatusBadge paymentMethodStatus={user.paymentMethodStatus} />
            <ResetAPIKeyButton userId={user.id} />
            {!user.is_sso_protected_domain && <ResetToMagicLinkLoginButton userId={user.id} />}
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/users/${encodeURIComponent(user.id)}/heuristic-abuse`}>
                View usage + abuse
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/users/${encodeURIComponent(user.id)}/webhooks`}>
                <Webhook className="mr-1 h-3.5 w-3.5" />
                Webhooks
              </Link>
            </Button>
            <a
              href={stripeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-purple-950 px-2.5 py-1.5 text-xs font-medium text-purple-200 transition-colors hover:bg-purple-900"
            >
              Stripe
              <SquareArrowOutUpRight size={12} />
            </a>
            <a
              href={hibpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md bg-orange-950 px-2.5 py-1.5 text-xs font-medium text-orange-200 transition-colors hover:bg-orange-900"
              title="Check if this email has been exposed in any data breaches"
            >
              HIBP
              <SquareArrowOutUpRight size={12} />
            </a>
            <img
              src={gravatarUrl}
              alt={`Gravatar for ${user.google_user_name}`}
              className="border-border h-7 w-7 rounded-full border"
              title="Gravatar"
            />
          </div>
        </div>

        {/* Metadata grid */}
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="User ID" mono>
            {user.id} <CopyTextButton text={user.id} />
          </Field>
          <Field label="Email">
            {user.google_user_email} <CopyTextButton text={user.google_user_email} />
          </Field>
          <Field label="Normalized Email">
            {user.normalized_email ?? <span className="text-muted-foreground">N/A</span>}
            {user.normalized_email ? <CopyTextButton text={user.normalized_email} /> : null}
          </Field>
          <Field label="Email Domain">
            {user.email_domain ?? <span className="text-muted-foreground">N/A</span>}
            {user.email_domain ? <CopyTextButton text={user.email_domain} /> : null}
          </Field>
          <Field label="Hosted Domain">
            {user.hosted_domain || 'N/A'}
            {user.hosted_domain ? <CopyTextButton text={user.hosted_domain} /> : null}
          </Field>
          <Field label="Created">{formatDate(user.created_at)}</Field>
          <Field label="Updated">{formatDate(user.updated_at)}</Field>
          <Field label="OpenRouter Upstream Safety ID" mono>
            {user.openrouter_upstream_safety_identifier ? (
              <>
                {user.openrouter_upstream_safety_identifier}
                <CopyTextButton text={user.openrouter_upstream_safety_identifier} />
              </>
            ) : (
              <span className="text-muted-foreground">N/A</span>
            )}
          </Field>
          <Field label="Vercel Downstream Safety ID" mono>
            {user.vercel_downstream_safety_identifier ? (
              <>
                {user.vercel_downstream_safety_identifier}
                <CopyTextButton text={user.vercel_downstream_safety_identifier} />
              </>
            ) : (
              <span className="text-muted-foreground">N/A</span>
            )}
          </Field>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <h4 className="text-muted-foreground text-xs font-medium">{label}</h4>
      <div
        className={`flex items-center gap-1 text-sm break-all ${mono ? 'font-mono text-xs' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
