import { type ErrorBoundaryProps } from 'expo-router';
import * as Sentry from '@sentry/react-native';

import { NewSessionErrorScreen } from '@/components/agents/new-session-error-screen';
import { NewSessionRoute } from '@/components/agents/new-session-route';

/**
 * A render error in the composer stays inside this route: the person keeps a
 * Back out of the screen, and Retry re-runs the prefill that was staging a
 * photo. Without this export the error reached the app-root boundary, whose
 * only control is Retry.
 */
function NewSessionErrorBoundary({ retry }: ErrorBoundaryProps) {
  return <NewSessionErrorScreen onRetry={() => void retry()} />;
}

export const ErrorBoundary = Sentry.wrapExpoRouterErrorBoundary(NewSessionErrorBoundary);

export default function NewSessionScreen() {
  return <NewSessionRoute />;
}
