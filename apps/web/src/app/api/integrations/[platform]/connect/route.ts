import type { NextRequest } from 'next/server';
import { handlePlatformOAuthConnect } from '@/lib/integrations/oauth/routes';

type RouteContext = {
  params: Promise<{ platform: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { platform } = await context.params;
  return handlePlatformOAuthConnect(request, platform);
}
