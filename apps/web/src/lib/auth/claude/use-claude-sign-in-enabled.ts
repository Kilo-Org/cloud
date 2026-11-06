'use client';

import { useFeatureFlagEnabled } from 'posthog-js/react';
import { CLAUDE_SIGN_IN_FLAG } from './access';

/** Client mirror of `isClaudeSignInEnabled`: hidden until the flag loads as true. */
export function useClaudeSignInEnabled(): boolean {
  const flagEnabled = useFeatureFlagEnabled(CLAUDE_SIGN_IN_FLAG);
  return process.env.NODE_ENV === 'development' || flagEnabled === true;
}
