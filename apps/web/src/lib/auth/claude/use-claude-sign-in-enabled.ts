'use client';

import { useFeatureFlagEnabled } from 'posthog-js/react';
import { CLAUDE_PLATFORM_OAUTH_FLAG } from '@kilocode/web-shared/lib/auth/claude/feature-flag';

export function useClaudeSignInEnabled(): boolean {
  const flagEnabled = useFeatureFlagEnabled(CLAUDE_PLATFORM_OAUTH_FLAG);
  return flagEnabled === true;
}
