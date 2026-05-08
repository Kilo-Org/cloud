import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export type PrototypeMetadata = {
  title: string;
  description: string;
  tags: string[];
};

export type PrototypeMetadataState = 'provided' | 'fallback' | 'invalid';

export type PrototypeCatalogEntry = PrototypeMetadata & {
  slug: string;
  href: string;
  metadataState: PrototypeMetadataState;
};

export type PrototypeCatalogDiagnosticCode = 'invalid-metadata';

export type PrototypeCatalogDiagnostic = {
  slug: string;
  severity: 'warning';
  code: PrototypeCatalogDiagnosticCode;
  message: string;
};

export type PrototypeCatalogState = {
  entries: PrototypeCatalogEntry[];
  diagnostics: PrototypeCatalogDiagnostic[];
};

type PrototypeMetadataReadResult =
  | { state: 'provided'; metadata: PrototypeMetadata }
  | { state: 'missing'; metadata: null }
  | { state: 'invalid'; metadata: null; diagnostic: PrototypeCatalogDiagnostic };

const APP_DIR = join(process.cwd(), 'src/app');
export const PROTOTYPE_PAGE_FILES = ['page.tsx', 'page.ts', 'page.jsx', 'page.js', 'page.mdx'];
export const INVALID_PROTOTYPE_METADATA_MESSAGE =
  'prototype.json must include a non-empty title, description, and tags array.';

export function getPrototypeCatalog(appDir = APP_DIR): PrototypeCatalogEntry[] {
  return getPrototypeCatalogState(appDir).entries;
}

export function getPrototypeCatalogState(appDir = APP_DIR): PrototypeCatalogState {
  const discoveredRoutes = readdirSync(appDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(isDiscoverableRouteSegment)
    .filter(slug => hasPageFile(join(appDir, slug)));

  const catalogItems = discoveredRoutes.map(slug => toCatalogItem(slug, join(appDir, slug)));

  return {
    entries: catalogItems.map(item => item.entry).sort((a, b) => a.title.localeCompare(b.title)),
    diagnostics: catalogItems.flatMap(item => item.diagnostics),
  };
}

export function isDiscoverableRouteSegment(name: string): boolean {
  return !name.startsWith('_') && !name.startsWith('.') && !name.startsWith('(') && name !== 'api';
}

function hasPageFile(routeDir: string): boolean {
  return PROTOTYPE_PAGE_FILES.some(file => existsSync(join(routeDir, file)));
}

function toCatalogItem(
  slug: string,
  routeDir: string
): { entry: PrototypeCatalogEntry; diagnostics: PrototypeCatalogDiagnostic[] } {
  const metadataResult = readPrototypeMetadata(slug, routeDir);
  const metadata = metadataResult.metadata ?? fallbackMetadata(slug);
  const metadataState: PrototypeMetadataState =
    metadataResult.state === 'provided'
      ? 'provided'
      : metadataResult.state === 'invalid'
        ? 'invalid'
        : 'fallback';

  return {
    entry: {
      slug,
      href: `/${slug}`,
      metadataState,
      ...metadata,
    },
    diagnostics: metadataResult.state === 'invalid' ? [metadataResult.diagnostic] : [],
  };
}

function readPrototypeMetadata(slug: string, routeDir: string): PrototypeMetadataReadResult {
  const metadataPath = join(routeDir, 'prototype.json');
  if (!existsSync(metadataPath) || !statSync(metadataPath).isFile()) {
    return { state: 'missing', metadata: null };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (isPrototypeMetadata(parsed)) return { state: 'provided', metadata: parsed };
  } catch {
    // Fall through to the shared invalid metadata diagnostic.
  }

  return {
    state: 'invalid',
    metadata: null,
    diagnostic: {
      slug,
      severity: 'warning',
      code: 'invalid-metadata',
      message: INVALID_PROTOTYPE_METADATA_MESSAGE,
    },
  };
}

export function isPrototypeMetadata(value: unknown): value is PrototypeMetadata {
  if (!value || typeof value !== 'object') return false;
  if (!('title' in value) || typeof value.title !== 'string' || value.title.trim() === '') {
    return false;
  }
  if (
    !('description' in value) ||
    typeof value.description !== 'string' ||
    value.description.trim() === ''
  ) {
    return false;
  }
  if (!('tags' in value) || !Array.isArray(value.tags)) return false;
  return value.tags.every(tag => typeof tag === 'string' && tag.trim() !== '');
}

function fallbackMetadata(slug: string): PrototypeMetadata {
  const title = slug
    .split('-')
    .filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');

  return {
    title: title || 'Untitled prototype',
    description: 'No prototype metadata yet. Add prototype.json beside the route page.',
    tags: ['Prototype'],
  };
}
