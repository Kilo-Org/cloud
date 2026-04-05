/**
 * PostHog tracking utilities for code-indexing feature
 *
 * This module provides wide-event style tracking for all code-indexing operations.
 * Events are designed to capture comprehensive context for analytics and debugging.
 */

import PostHogClient from '@/lib/posthog';
import { captureException } from '@sentry/nextjs';

const posthogClient = PostHogClient();

type BaseCodeIndexingEvent = {
  distinctId: string;
  organizationId: string;
  userId: string;
  projectId?: string;
};

type CodeIndexingSearchEvent = BaseCodeIndexingEvent & {
  query: string;
  path?: string;
  preferBranch?: string;
  fallbackBranch: string;
  excludeFilesCount: number;
  resultsCount: number;
  hasResults: boolean;
};

type CodeIndexingDeleteEvent = BaseCodeIndexingEvent & {
  projectId: string;
  gitBranch?: string;
  filePathsCount?: number;
  deletedFiles: number;
  success: boolean;
};

type CodeIndexingManifestEvent = BaseCodeIndexingEvent & {
  projectId: string;
  gitBranch: string;
  totalFiles: number;
};

type CodeIndexingStatsEvent = BaseCodeIndexingEvent & {
  projectsCount: number;
  totalChunks: number;
  totalFiles: number;
  totalSizeKb: number;
  isAdminOverride: boolean;
};

type CodeIndexingProjectFilesEvent = BaseCodeIndexingEvent & {
  projectId: string;
  page: number;
  pageSize: number;
  totalFiles: number;
  totalPages: number;
  isAdminOverride: boolean;
};

type CodeIndexingDeleteBeforeDateEvent = BaseCodeIndexingEvent & {
  beforeDate: string;
  success: boolean;
};

type CodeIndexingUpsertEvent = BaseCodeIndexingEvent & {
  projectId: string;
  filePath: string;
  gitBranch: string;
  isBaseBranch: boolean;
  chunksProcessed: number;
  fileSizeBytes: number;
  success: boolean;
};

/**
 * Track code indexing search operation
 */
export function trackCodeIndexingSearch(properties: CodeIndexingSearchEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'code_indexing_search',
      properties: {
        ...properties,
        feature: 'code-indexing',
        operation: 'search',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_code_indexing_search' },
      extra: { properties },
    });
  }
}

/**
 * Track code indexing delete operation
 */
export function trackCodeIndexingDelete(properties: CodeIndexingDeleteEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'code_indexing_delete',
      properties: {
        ...properties,
        feature: 'code-indexing',
        operation: 'delete',
        deleteType: properties.gitBranch
          ? properties.filePathsCount
            ? 'files'
            : 'branch'
          : 'project',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_code_indexing_delete' },
      extra: { properties },
    });
  }
}

/**
 * Track code indexing manifest retrieval
 */
export function trackCodeIndexingManifest(properties: CodeIndexingManifestEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'code_indexing_manifest',
      properties: {
        ...properties,
        feature: 'code-indexing',
        operation: 'get_manifest',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_code_indexing_manifest' },
      extra: { properties },
    });
  }
}

/**
 * Track code indexing stats retrieval
 */
export function trackCodeIndexingStats(properties: CodeIndexingStatsEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'code_indexing_stats',
      properties: {
        ...properties,
        feature: 'code-indexing',
        operation: 'get_stats',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_code_indexing_stats' },
      extra: { properties },
    });
  }
}

/**
 * Track code indexing project files retrieval
 */
export function trackCodeIndexingProjectFiles(properties: CodeIndexingProjectFilesEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'code_indexing_project_files',
      properties: {
        ...properties,
        feature: 'code-indexing',
        operation: 'get_project_files',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_code_indexing_project_files' },
      extra: { properties },
    });
  }
}

/**
 * Track code indexing delete before date operation
 */
export function trackCodeIndexingDeleteBeforeDate(
  properties: CodeIndexingDeleteBeforeDateEvent
): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'code_indexing_delete_before_date',
      properties: {
        ...properties,
        feature: 'code-indexing',
        operation: 'delete_before_date',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_code_indexing_delete_before_date' },
      extra: { properties },
    });
  }
}

/**
 * Track code indexing file upsert operation
 */
export function trackCodeIndexingUpsert(properties: CodeIndexingUpsertEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'code_indexing_upsert',
      properties: {
        ...properties,
        feature: 'code-indexing',
        operation: 'upsert',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_code_indexing_upsert' },
      extra: { properties },
    });
  }
}
