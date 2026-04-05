import { redirect } from 'next/navigation';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { DeviceAuthClient } from './DeviceAuthClient';

type PageProps = {
  searchParams: Promise<{ code?: string }>;
};

export default async function DeviceAuthPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const code = params.code;

  // Redirect to login if not authenticated, with callback to return here
  const callbackPath = `/device-auth${code ? `?code=${encodeURIComponent(code)}` : ''}`;
  await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`
  );

  if (!code) {
    redirect('/');
  }

  return <DeviceAuthClient code={code} />;
}
