import type { NextRequest } from 'next/server';
import {
  handlePlatformOAuthConnect,
  handlePlatformOAuthConnectPost,
} from '@/lib/integrations/oauth/routes';

type RouteContext = {
  params: Promise<{ platform: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { platform } = await context.params;
  return handlePlatformOAuthConnect(request, platform);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { platform } = await context.params;
  return handlePlatformOAuthConnectPost(request, platform);
}
