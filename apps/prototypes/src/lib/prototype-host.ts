import type { Metadata, Viewport } from 'next';

export const PROTOTYPE_HOST_THEME_SOURCE = '@web/app/globals.css';

export const PROTOTYPE_HOST_METADATA = {
  title: 'Kilo Code Prototypes',
  description: 'Full-page Kilo Code product-flow prototypes for design review.',
} satisfies Metadata;

export const PROTOTYPE_HOST_VIEWPORT = {
  themeColor: '#171717',
  width: 'device-width',
  initialScale: 1,
} satisfies Viewport;

export function createPrototypeHostClassName(fontVariables: readonly string[]): string {
  return [...fontVariables, 'antialiased'].filter(Boolean).join(' ');
}
