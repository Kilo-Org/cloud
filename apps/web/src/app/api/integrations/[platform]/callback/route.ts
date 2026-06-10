import type { NextRequest } from 'next/server';
import { handlePlatformOAuthCallback } from '@/lib/integrations/oauth/routes';

type RouteContext = {
  params: Promise<{ platform: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { platform } = await context.params;
  return handlePlatformOAuthCallback(request, platform);
}
