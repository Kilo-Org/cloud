import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { generateAccessCode } from '@/lib/kiloclaw/access-codes';

export async function POST() {
  const { user } = await getUserFromAuth({ adminOnly: false });
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { code, expiresAt } = await generateAccessCode(user.id);

  return NextResponse.json({
    code,
    expiresIn: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  });
}
