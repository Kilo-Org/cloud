import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
// Single source of truth for the device-auth code shape. The shared
// `isOpenclawAdvisorCallback` helper applies the same regex on the
// callback-path side so the page-level guard here and the attribution
// guard at /account-verification can't drift.
import { DEVICE_AUTH_CODE_FORMAT } from '@/lib/signup-source';

type PageProps = {
  searchParams: Promise<{ code?: string }>;
};

export default async function OpenclawAdvisorPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const rawCode = params.code;
  const code = rawCode && DEVICE_AUTH_CODE_FORMAT.test(rawCode) ? rawCode : undefined;

  // Short-circuit BEFORE the auth redirect when the code is missing or
  // malformed. Otherwise an unauthenticated visit to
  // `/openclaw-advisor` (no code, or `?code=garbage`) would set
  // `callbackPath=/openclaw-advisor` on the sign-in redirect, and
  // account-verification would then read that callback as a signal that
  // the user arrived through the Security Advisor plugin and grant the
  // product-specific signup bonus — without the user ever having a
  // device-auth session to complete. Bouncing to `/` here means
  // callbackPath never carries the bonus-eligible path for code-less
  // visits, so bonus attribution stays tied to real plugin traffic.
  if (!code) {
    redirect('/');
  }

  // code has already been validated against [A-Za-z0-9-]{1,16}, so no
  // per-char encoding is needed when building the inner callback path.
  // The outer encodeURIComponent around the whole callbackPath is still
  // required so the `?` and `=` it contains travel as a single query-param
  // value into /users/sign_in.
  const callbackPath = `/openclaw-advisor?code=${code}`;
  await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`
  );

  // Same rationale as above: `code` is validated, so percent-encoding is redundant.
  redirect(`/device-auth?code=${code}`);
}
