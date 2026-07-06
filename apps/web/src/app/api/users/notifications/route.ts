import type { KiloNotification } from '@/lib/notifications';
import { generateUserNotifications } from '@/lib/notifications';
import { getUserFromAuth } from '@/lib/user/server';
import {
  getKiloCodeVersionNumber,
  getOpenCodeKiloVersionNumber,
  getXKiloCodeVersionNumber,
} from '@/lib/userAgent';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | { notifications: KiloNotification[] }>> {
  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  // The current extension sends its version via the `opencode-kilo-provider/<version>`
  // User-Agent. Older clients (e.g. `Kilo-Code/<version>`) and the `X-KiloCode-Version`
  // header are also honored. The legacy extension sends none of these, leaving the
  // version undefined — which notifications.ts treats as a pre-versioning old client.
  const userAgent = request.headers.get('user-agent');
  const numericExtensionVersion =
    getOpenCodeKiloVersionNumber(userAgent) ??
    getKiloCodeVersionNumber(userAgent) ??
    getXKiloCodeVersionNumber(request.headers.get('X-KiloCode-Version')) ??
    undefined;

  const notifications = await generateUserNotifications(user, { numericExtensionVersion });

  return NextResponse.json({ notifications });
}
