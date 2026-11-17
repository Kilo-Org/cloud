import 'server-only';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { CLAUDE_PLATFORM_OAUTH_FLAG } from './feature-flag';

export async function isClaudePlatformOAuthEnabled(
  email: string | null | undefined
): Promise<boolean> {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return false;
  return isReleaseToggleEnabled(CLAUDE_PLATFORM_OAUTH_FLAG, normalizedEmail, {
    email: normalizedEmail,
  });
}
