import type { KiloNotification } from '@/lib/notifications';
import { generateUserNotifications } from '@/lib/notifications';
import { getUserFromAuth } from '@/lib/user.server';
import { NextResponse } from 'next/server';

export async function GET(): Promise<
  NextResponse<{ error: string } | { notifications: KiloNotification[] }>
> {
  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  const notifications = await generateUserNotifications(user);

  return NextResponse.json({ notifications });
}
