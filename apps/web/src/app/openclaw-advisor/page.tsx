import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';

type PageProps = {
  searchParams: Promise<{ code?: string }>;
};

// Device-auth codes are generated as `XXXX-XXXX` from an unambiguous
// alphanumeric charset (see generateDeviceCode in lib/device-auth/device-auth.ts).
// This guard drops obviously malformed input before it reaches the device-auth
// flow and eliminates any risk of injecting non-code content via the query param.
const DEVICE_AUTH_CODE_FORMAT = /^[A-Za-z0-9-]{1,16}$/;

export default async function OpenclawAdvisorPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const rawCode = params.code;
  const code = rawCode && DEVICE_AUTH_CODE_FORMAT.test(rawCode) ? rawCode : undefined;

  // code has already been validated against [A-Za-z0-9-]{1,16}, so no
  // per-char encoding is needed when building the inner callback path.
  // The outer encodeURIComponent around the whole callbackPath is still
  // required so the `?` and `=` it contains travel as a single query-param
  // value into /users/sign_in.
  const callbackPath = `/openclaw-advisor${code ? `?code=${code}` : ''}`;
  await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`
  );

  if (!code) {
    redirect('/');
  }

  // Same rationale as above: `code` is validated, so percent-encoding is redundant.
  redirect(`/device-auth?code=${code}`);
}
