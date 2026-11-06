import 'server-only';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { CLAUDE_SIGN_IN_FLAG } from './access';

/**
 * Whether Sign in with Claude is launched. Local development always allows it;
 * elsewhere only the boolean release toggle does, and a PostHog failure keeps it
 * closed.
 */
export async function isClaudeSignInEnabled(): Promise<boolean> {
  return (
    process.env.NODE_ENV === 'development' || (await isReleaseToggleEnabled(CLAUDE_SIGN_IN_FLAG))
  );
}
