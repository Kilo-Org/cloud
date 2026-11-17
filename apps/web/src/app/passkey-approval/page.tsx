import Link from 'next/link';
import type { Metadata } from 'next';
import * as z from 'zod';

import { Button } from '@/components/ui/button';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { buildEnterpriseSsoHref } from '@/lib/auth/sign-in-navigation';
import {
  evaluatePasskeyManagementApproval,
  type PasskeyManagementApprovalState,
} from '@/lib/auth/passkey-management-approval';
import type { PasskeyManagementOperation } from '@/lib/auth/passkey-management';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Approve a passkey change',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const OPERATION_COPY: Record<PasskeyManagementOperation, string> = {
  enroll: 'add a passkey to your account',
  rename: 'rename one of your passkeys',
  remove: 'remove one of your passkeys',
};

function firstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * One path segment by design: `isValidCallbackPath` accepts only that shape, so
 * the sign-in round trip can return here.
 */
function approvalPagePath(requestId: string): string {
  return `/passkey-approval?request=${encodeURIComponent(requestId)}`;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-foreground shadow-sm">
        {children}
      </div>
    </main>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h1 className="mb-2 text-lg font-semibold">{children}</h1>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** What the reader can do about a state that is not actionable yet. */
function ActionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <Button asChild>
        <Link href={href}>{children}</Link>
      </Button>
    </div>
  );
}

function nonReadyState(
  state: Exclude<PasskeyManagementApprovalState, { status: 'ready' } | { status: 'approved' }>,
  requestId: string | undefined,
  signedInEmail: string | undefined
) {
  switch (state.status) {
    case 'expired':
      return (
        <Frame>
          <Heading>This approval link expired</Heading>
          <Body>
            Passkey changes are approved within a few minutes of the request. Return to the Kilo app
            and start again.
          </Body>
        </Frame>
      );
    case 'sign_in':
      return (
        <Frame>
          <Heading>Sign in to approve</Heading>
          <Body>
            Sign in with your organization SSO to approve this change. The approval is bound to the
            account that asked for it.
          </Body>
          <ActionLink href={requestId ? signInHref(requestId) : signInHref(undefined)}>
            Sign in with SSO
          </ActionLink>
        </Frame>
      );
    case 'wrong_account':
      return (
        <Frame>
          <Heading>This request belongs to another account</Heading>
          <Body>
            You are signed in as {signedInEmail ?? state.signedInEmail}. Sign in with the account
            that requested this change, then approve it.
          </Body>
          <ActionLink href={requestId ? switchAccountHref(requestId) : '/users/sign_in?sso=true'}>
            Sign in with another account
          </ActionLink>
        </Frame>
      );
    case 'stale':
      return (
        <Frame>
          <Heading>Sign in again to approve</Heading>
          <Body>
            This browser last signed in more than ten minutes ago. A passkey change needs a fresh
            sign-in, so approve after signing in again.
          </Body>
          <ActionLink href={requestId ? signInHref(requestId) : signInHref(undefined)}>
            Sign in with SSO
          </ActionLink>
        </Frame>
      );
    case 'sso_required':
      return (
        <Frame>
          <Heading>Approve through your organization SSO</Heading>
          <Body>
            This account&apos;s domain requires SSO. Sign in with SSO, then approve the change.
          </Body>
          <ActionLink href={requestId ? signInHref(requestId) : signInHref(undefined)}>
            Sign in with SSO
          </ActionLink>
        </Frame>
      );
    case 'organization_not_required':
      return (
        <Frame>
          <Heading>This change needs a different confirmation</Heading>
          <Body>
            Your account no longer requires SSO, so the Kilo app confirms this change with an email
            code or an existing passkey. Return to the app and start again.
          </Body>
        </Frame>
      );
  }
}

function signInHref(requestId: string | undefined): string {
  return buildEnterpriseSsoHref(requestId ? { callbackPath: approvalPagePath(requestId) } : {});
}

/**
 * A generic SSO sign-in that returns here. It deliberately names no account:
 * the request id is public, so the page must not hint at the owning address.
 */
function switchAccountHref(requestId: string): string {
  const params = new URLSearchParams({
    sso: 'true',
    callbackPath: approvalPagePath(requestId),
  });
  return `/users/sign_in?${params.toString()}`;
}

/**
 * A map, not an object literal: a query string such as `error=__proto__` or
 * `error=constructor` must never reach a prototype property, and a Map has no
 * inherited keys to fall back to.
 */
const ERROR_HEADINGS = new Map<string, string>([
  ['invalid_request', 'This approval link is incomplete'],
  ['expired', 'This approval link expired'],
  ['sign_in', 'Sign in to approve'],
  ['wrong_account', 'This request belongs to another account'],
  ['stale', 'Sign in again to approve'],
  ['sso_required', 'Approve through your organization SSO'],
  ['organization_not_required', 'This change needs a different confirmation'],
]);

/**
 * The request id is a uuid column key. A malformed value must read as an
 * expired link instead of reaching the query, so an arbitrary string cannot
 * turn a public URL into a server error.
 */
const REQUEST_ID = z.uuid();

export default async function PasskeyManagementApprovePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const parsedRequestId = REQUEST_ID.safeParse(firstValue(params['request']));
  const requestId = parsedRequestId.success ? parsedRequestId.data : undefined;
  const errorParam = firstValue(params['error']);
  const errorHeading = errorParam === undefined ? undefined : ERROR_HEADINGS.get(errorParam);

  const auth = await getUserFromSessionForCredentialIssuance();
  const state = requestId
    ? await evaluatePasskeyManagementApproval({
        requestId,
        session: auth.user
          ? {
              userId: auth.user.id,
              email: auth.user.google_user_email,
              authenticatedAt: auth.authenticatedAt,
              ssoSourceOrganizationId: auth.ssoSourceOrganizationId,
            }
          : null,
      })
    : ({ status: 'expired' } as const);

  if (state.status === 'approved') {
    return (
      <Frame>
        <Heading>Change approved</Heading>
        <Body>
          Return to the Kilo app to finish. The approval is used once and expires shortly.
        </Body>
      </Frame>
    );
  }

  if (errorHeading && state.status !== 'ready') {
    return (
      <Frame>
        <Heading>{errorHeading}</Heading>
        <Body>Return to the Kilo app and start the change again. This approval was not used.</Body>
      </Frame>
    );
  }

  if (state.status !== 'ready') {
    return nonReadyState(state, requestId, auth.user?.google_user_email);
  }

  return (
    <Frame>
      <Heading>Approve passkey change</Heading>
      <Body>
        The Kilo app on a signed-in device asked to {OPERATION_COPY[state.operation]} for{' '}
        {state.accountEmail}. Approving confirms it was you; the app then completes the change.
      </Body>
      <form method="post" action="/api/auth/passkey/management/approve" className="mt-5">
        <input type="hidden" name="request" value={state.requestId} />
        <Button type="submit">Approve</Button>
      </form>
      <p className="mt-3 text-xs text-muted-foreground">
        If you did not start this, close this page. Nothing changes without your approval.
      </p>
    </Frame>
  );
}
