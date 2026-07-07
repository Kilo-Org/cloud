import type { KiloNotification } from '@/lib/notifications';
import { generateUserNotifications } from '@/lib/notifications';
import { getUserFromAuth } from '@/lib/user/server';
import { isLegacyKiloExtensionNotificationsUserAgent } from '@/lib/userAgent';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | { notifications: KiloNotification[] }>> {
  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  // The legacy extension calls this endpoint with axios (User-Agent: axios/<version>),
  // while the current extension/CLI use the shared Kilo gateway headers. Detecting the
  // axios User-Agent lets us target the legacy-extension end-of-life notice precisely.
  const isLegacyExtension = isLegacyKiloExtensionNotificationsUserAgent(
    request.headers.get('user-agent')
  );

  const notifications = await generateUserNotifications(user, { isLegacyExtension });

  return NextResponse.json({ notifications });
}
