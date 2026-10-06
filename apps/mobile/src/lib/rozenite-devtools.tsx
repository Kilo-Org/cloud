import { createExpoFileSystemAdapter, useFileSystemDevTools } from '@rozenite/file-system-plugin';
import { useNetworkActivityDevTools } from '@rozenite/network-activity-plugin';
import { RozeniteOverlay } from '@rozenite/overlay-plugin';
import { usePerformanceMonitorDevTools } from '@rozenite/performance-monitor-plugin';
import { useReactNavigationDevTools } from '@rozenite/react-navigation-plugin';
import { useRequireProfilerDevTools } from '@rozenite/require-profiler-plugin';
import { useTanStackQueryDevTools } from '@rozenite/tanstack-query-plugin';
import * as FileSystem from 'expo-file-system';
import { useNavigationContainerRef } from 'expo-router';

import { queryClient } from '@/lib/query-client';

const FILE_SYSTEM_ADAPTER = createExpoFileSystemAdapter(FileSystem);

/**
 * Rozenite panels for React Native DevTools. Every hook and the overlay are
 * no-ops in a production bundle; the panels appear only when Metro starts with
 * `WITH_ROZENITE=true` (set in `apps/mobile/.env.development.local`; the dev
 * runner rewrites `.env.local` on every start). The overlay draws
 * nothing until its panel turns a grid or a reference image on.
 */
export function RozeniteDevTools() {
  const navigationRef = useNavigationContainerRef();
  useTanStackQueryDevTools(queryClient);
  useNetworkActivityDevTools();
  useReactNavigationDevTools({ ref: navigationRef });
  useFileSystemDevTools({ adapter: FILE_SYSTEM_ADAPTER });
  useRequireProfilerDevTools();
  usePerformanceMonitorDevTools();
  return <RozeniteOverlay />;
}
