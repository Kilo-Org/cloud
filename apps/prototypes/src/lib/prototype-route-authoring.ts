import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  INVALID_PROTOTYPE_METADATA_MESSAGE,
  PROTOTYPE_PAGE_FILES,
  isDiscoverableRouteSegment,
  isPrototypeMetadata,
} from './prototypes';

export type PrototypeRouteIssue = {
  severity: 'error' | 'warning';
  code: 'missing-page' | 'invalid-route-segment' | 'invalid-metadata';
  message: string;
};

export type PrototypeRouteValidationResult = {
  slug: string;
  valid: boolean;
  issues: PrototypeRouteIssue[];
  recommendedImports: string[];
};

const RECOMMENDED_IMPORTS = [
  '@/components/prototype-kit',
  '@/components/ui/*',
  '@/components/shared/*',
];

export function validatePrototypeRoute({
  appDir,
  slug,
}: {
  appDir: string;
  slug: string;
}): PrototypeRouteValidationResult {
  const routeDir = join(appDir, slug);
  const issues: PrototypeRouteIssue[] = [];

  if (!isDiscoverableRouteSegment(slug)) {
    issues.push({
      severity: 'error',
      code: 'invalid-route-segment',
      message: 'Prototype route folders must be discoverable app segments.',
    });
  }

  if (!hasPageFile(routeDir)) {
    issues.push({
      severity: 'error',
      code: 'missing-page',
      message: 'Prototype routes need a page file such as page.tsx.',
    });
  }

  if (hasInvalidMetadata(routeDir)) {
    issues.push({
      severity: 'warning',
      code: 'invalid-metadata',
      message: INVALID_PROTOTYPE_METADATA_MESSAGE,
    });
  }

  return {
    slug,
    valid: issues.every(issue => issue.severity !== 'error' && issue.code !== 'invalid-metadata'),
    issues,
    recommendedImports: RECOMMENDED_IMPORTS,
  };
}

function hasPageFile(routeDir: string): boolean {
  return PROTOTYPE_PAGE_FILES.some(file => existsSync(join(routeDir, file)));
}

function hasInvalidMetadata(routeDir: string): boolean {
  const metadataPath = join(routeDir, 'prototype.json');
  if (!existsSync(metadataPath) || !statSync(metadataPath).isFile()) return false;

  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    return !isPrototypeMetadata(parsed);
  } catch {
    return true;
  }
}
