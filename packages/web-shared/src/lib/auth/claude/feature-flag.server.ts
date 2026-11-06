import 'server-only';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { CLAUDE_PLATFORM_OAUTH_FLAG } from './feature-flag';

export const isClaudePlatformOAuthEnabled = createCachedFetch(
  () => isReleaseToggleEnabled(CLAUDE_PLATFORM_OAUTH_FLAG),
  30_000,
  false,
  { name: CLAUDE_PLATFORM_OAUTH_FLAG }
);
