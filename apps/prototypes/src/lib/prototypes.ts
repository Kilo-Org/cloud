import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export type PrototypeMetadata = {
  title: string;
  description: string;
  tags: string[];
};

export type PrototypeCatalogEntry = PrototypeMetadata & {
  slug: string;
  href: string;
  metadataState: 'provided' | 'fallback';
};

const APP_DIR = join(process.cwd(), 'src/app');
const PAGE_FILES = ['page.tsx', 'page.ts', 'page.jsx', 'page.js', 'page.mdx'];

export function getPrototypeCatalog(appDir = APP_DIR): PrototypeCatalogEntry[] {
  return readdirSync(appDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(isDiscoverableRouteSegment)
    .filter(slug => hasPageFile(join(appDir, slug)))
    .map(slug => toCatalogEntry(slug, join(appDir, slug)))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function isDiscoverableRouteSegment(name: string): boolean {
  return !name.startsWith('_') && !name.startsWith('.') && !name.startsWith('(') && name !== 'api';
}

function hasPageFile(routeDir: string): boolean {
  return PAGE_FILES.some(file => existsSync(join(routeDir, file)));
}

function toCatalogEntry(slug: string, routeDir: string): PrototypeCatalogEntry {
  const metadata = readPrototypeMetadata(routeDir) ?? fallbackMetadata(slug);
  return {
    slug,
    href: `/${slug}`,
    metadataState: readPrototypeMetadata(routeDir) ? 'provided' : 'fallback',
    ...metadata,
  };
}

function readPrototypeMetadata(routeDir: string): PrototypeMetadata | null {
  const metadataPath = join(routeDir, 'prototype.json');
  if (!existsSync(metadataPath) || !statSync(metadataPath).isFile()) return null;

  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (!isPrototypeMetadata(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPrototypeMetadata(value: unknown): value is PrototypeMetadata {
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
