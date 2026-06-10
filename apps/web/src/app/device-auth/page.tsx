import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { DeviceAuthClient } from './DeviceAuthClient';
import { buildDeviceAuthPath, isDeviceAuthAppMode } from './device-auth-url';

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const deviceAuthSearchParamsSchema = z.object({
  code: z.preprocess(
    value => (Array.isArray(value) ? value[0] : value),
    z.string().min(1).optional()
  ),
  app: z.union([z.string(), z.array(z.string())]).optional(),
});

export default async function DeviceAuthPage({ searchParams }: PageProps) {
  const params = deviceAuthSearchParamsSchema.parse(await searchParams);
  const code = params.code;
  const isAppMode = isDeviceAuthAppMode(params.app);

  // Redirect to login if not authenticated, with callback to return here
  const callbackPath = code ? buildDeviceAuthPath(code, { app: isAppMode }) : '/device-auth';
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`
  );

  if (!code) {
    redirect('/');
  }

  return (
    <DeviceAuthClient
      code={code}
      isAppMode={isAppMode}
      user={{
        name: user.google_user_name,
        email: user.google_user_email,
        imageUrl: user.google_user_image_url,
      }}
    />
  );
}
