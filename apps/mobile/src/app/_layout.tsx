// Must run before the first view mounts: allowRTL(true) makes the native
// direction known before any layout pass (see src/i18n/rtl.ts).
// eslint-disable-next-line import/no-duplicates -- the side effect must run here, before the named import below
import '@/i18n/rtl';
import '../global.css';
import '@/lib/cloud-agent-runtime';

import * as Sentry from '@sentry/react-native';
import { ErrorBoundary as ExpoRouterErrorBoundary } from 'expo-router';

import { RootLayoutController } from '@/components/root-layout-controller';

export const ErrorBoundary = Sentry.wrapExpoRouterErrorBoundary(ExpoRouterErrorBoundary);

export default Sentry.wrap(RootLayoutController);
