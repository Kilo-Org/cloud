import type { KiloNotification } from '@/lib/notifications';
import { generateUserNotifications } from '@/lib/notifications';
import { getUserFromAuth } from '@/lib/user/server';
import { getKiloCodeVersionNumber, getXKiloCodeVersionNumber } from '@/lib/userAgent';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest
): Promise<NextResponse<{ error: string } | { notifications: KiloNotification[] }>> {
  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  const numericExtensionVersion =
    getXKiloCodeVersionNumber(request.headers.get('X-KiloCode-Version')) ??
    getKiloCodeVersionNumber(request.headers.get('user-agent')) ??
    undefined;

  const notifications = await generateUserNotifications(user, { numericExtensionVersion });

  return NextResponse.json({ notifications });
}
