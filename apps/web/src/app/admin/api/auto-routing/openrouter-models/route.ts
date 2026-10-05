import { NextResponse } from 'next/server';
import { getRawOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  try {
    const models = await getRawOpenRouterModels();
    return NextResponse.json(models);
  } catch {
    return NextResponse.json({ error: 'Failed to fetch OpenRouter models' }, { status: 500 });
  }
}
