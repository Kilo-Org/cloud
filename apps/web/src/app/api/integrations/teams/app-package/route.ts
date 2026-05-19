import {
  buildTeamsAppPackage,
  getTeamsAppPackageFileName,
} from '@/lib/integrations/teams-app-package';
import { getUserFromAuth } from '@/lib/user.server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;

  const zip = await buildTeamsAppPackage();
  const body = new ArrayBuffer(zip.byteLength);
  new Uint8Array(body).set(zip);

  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${getTeamsAppPackageFileName()}"`,
      'cache-control': 'no-store',
    },
  });
}
