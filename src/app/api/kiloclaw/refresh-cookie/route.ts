import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { setWorkerAuthCookie } from '@/lib/kiloclaw/worker-auth-cookie';

export async function POST() {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await setWorkerAuthCookie(user);
  return NextResponse.json({ ok: true });
}
