/**
 * Preview Polling Module
 *
 * Handles polling for preview status and automatic build triggers.
 */

import type { PreviewPollingConfig, PreviewPollingState } from './types';

export type { PreviewPollingConfig, PreviewPollingState };

/**
 * Default polling configuration.
 */
export const POLLING_CONFIG = {
  maxAttempts: 30,
  baseDelay: 2000,
  maxDelay: 10000,
  idleThresholdForBuild: 2,
} as const;

/**
 * Starts polling for preview status.
 * Returns a control object to stop polling.
 */
export function startPreviewPolling(config: PreviewPollingConfig): PreviewPollingState {
  const { projectId, organizationId, trpcClient, store, isDestroyed } = config;

  // Polling state (mutable reference for the closure)
  const pollingState: PreviewPollingState = {
    isPolling: true,
    stop: () => {
      pollingState.isPolling = false;
    },
  };

  // Start the polling loop asynchronously
  void runPollingLoop(pollingState, projectId, organizationId, trpcClient, store, isDestroyed);

  return pollingState;
}

/**
 * The main polling loop.
 */
async function runPollingLoop(
  pollingState: PreviewPollingState,
  projectId: string,
  organizationId: string | null,
  trpcClient: PreviewPollingConfig['trpcClient'],
  store: PreviewPollingConfig['store'],
  isDestroyed: () => boolean
): Promise<void> {
  const currentStatus = store.getState().previewStatus;

  // Only set to 'building' if not already 'running' to avoid visual flicker
  if (currentStatus !== 'running') {
    store.setState({ previewStatus: 'building' });
  }

  // Track consecutive idle responses to trigger automatic build
  let consecutiveIdleCount = 0;

  try {
    for (let attempt = 0; attempt < POLLING_CONFIG.maxAttempts; attempt++) {
      // Check if polling should stop
      if (!pollingState.isPolling || isDestroyed()) {
        return;
      }

      const result = organizationId
        ? await trpcClient.organizations.appBuilder.getPreviewUrl.query({
            projectId,
            organizationId,
          })
        : await trpcClient.appBuilder.getPreviewUrl.query({
            projectId,
          });

      // Check again after async operation
      if (!pollingState.isPolling || isDestroyed()) {
        return;
      }

      if (result.status === 'running' && result.previewUrl) {
        store.setState({ previewUrl: result.previewUrl, previewStatus: 'running' });
        return;
      }

      if (result.status === 'error') {
        store.setState({ previewStatus: 'error' });
        return;
      }

      // Track consecutive idle responses and trigger build automatically
      if (result.status === 'idle') {
        consecutiveIdleCount++;

        if (consecutiveIdleCount >= POLLING_CONFIG.idleThresholdForBuild) {
          try {
            if (organizationId) {
              await trpcClient.organizations.appBuilder.triggerBuild.mutate({
                projectId,
                organizationId,
              });
            } else {
              await trpcClient.appBuilder.triggerBuild.mutate({
                projectId,
              });
            }
            store.setState({ previewStatus: 'building' });
          } catch {
            // Build trigger failed, continue polling
          }
        }
      } else {
        consecutiveIdleCount = 0;
      }

      const delay = Math.min(
        POLLING_CONFIG.baseDelay * Math.pow(1.5, attempt),
        POLLING_CONFIG.maxDelay
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Max attempts reached
    store.setState({ previewStatus: 'error' });
  } catch {
    // Polling error - set error status unless destroyed
    if (!isDestroyed()) {
      store.setState({ previewStatus: 'error' });
    }
  } finally {
    pollingState.isPolling = false;
  }
}
