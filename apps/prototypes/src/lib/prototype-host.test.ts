import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROTOTYPE_HOST_METADATA,
  PROTOTYPE_HOST_THEME_SOURCE,
  PROTOTYPE_HOST_VIEWPORT,
  createPrototypeHostClassName,
} from './prototype-host';

test('prototype host exposes root metadata, viewport, theme source, and font class composition', () => {
  assert.deepEqual(PROTOTYPE_HOST_METADATA, {
    title: 'Kilo Code Prototypes',
    description: 'Full-page Kilo Code product-flow prototypes for design review.',
  });
  assert.deepEqual(PROTOTYPE_HOST_VIEWPORT, {
    themeColor: '#171717',
    width: 'device-width',
    initialScale: 1,
  });
  assert.equal(PROTOTYPE_HOST_THEME_SOURCE, '@web/app/globals.css');
  assert.equal(
    createPrototypeHostClassName(['inter-variable', 'mono-variable', 'jetbrains-variable']),
    'inter-variable mono-variable jetbrains-variable antialiased'
  );
});
