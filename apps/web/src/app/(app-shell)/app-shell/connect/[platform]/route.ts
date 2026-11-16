import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { appShellRedirect } from '@/lib/app-shell/redirect';
import { requireAppShellUser } from '@/lib/app-shell/session';
import { APP_SHELL_EXPIRED_PATH, APP_SHELL_PLATFORMS } from '@/lib/app-shell/shell-paths';
import {
  handlePlatformOAuthConnectForAppShell,
  handlePlatformOAuthConnectPostForAppShell,
} from '@/lib/integrations/oauth/routes';

type RouteContext = {
  params: Promise<{ platform: string }>;
};

function isShellPlatform(platform: string): boolean {
  return (APP_SHELL_PLATFORMS as readonly string[]).includes(platform);
}

/**
 * The shell's own OAuth start. It resolves the caller from the shell session
 * (this route sits under the cookie's `Path`), mints a state marked as a shell
 * flow, and binds the attempt to this browser with a `/api/integrations` cookie
 * so the callback can identify the user without a full web session.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const { platform } = await context.params;
  if (!isShellPlatform(platform)) {
    return NextResponse.json({ error: 'Unsupported provider' }, { status: 404 });
  }

  const user = await requireAppShellUser();
  if (!user) {
    return appShellRedirect(APP_SHELL_EXPIRED_PATH);
  }

  return handlePlatformOAuthConnectForAppShell(request, platform, user);
}

/** The self-hosted GitLab form posts here instead of to the full app's route. */
export async function POST(request: NextRequest, context: RouteContext) {
  const { platform } = await context.params;
  const user = await requireAppShellUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return handlePlatformOAuthConnectPostForAppShell(request, platform, user);
}
