/* eslint-disable typescript-eslint/consistent-type-assertions -- a llama.rn context is a JSI object: a test double can only be built by asserting its shape */
import { expect, it, vi } from 'vitest';

import { loadProjector, projectorReadsImages } from './gguf-client';

/**
 * The two answers llama.cpp gives when a projector does not read images:
 * `initMultimodal` returning false is a refused load, which says nothing about
 * the bytes, and a load that reports no vision is the verdict about them.
 */
function contextOf(loads: boolean, vision: boolean) {
  return {
    initMultimodal: vi.fn(() => Promise.resolve(loads)),
    getMultimodalSupport: vi.fn(() => Promise.resolve({ vision, audio: false })),
  };
}

it('reports a projector that failed to load as refused, not as a vision verdict', async () => {
  const context = contextOf(false, false);

  await expect(loadProjector(context, '/models/a.mmproj.gguf', true)).resolves.toBe('refused');
  // A refused load never asks for support: there is no loaded projector to ask.
  expect(context.getMultimodalSupport).not.toHaveBeenCalled();
});

it('reports a projector that loaded without image support as its own verdict', async () => {
  const context = contextOf(true, false);

  await expect(loadProjector(context, '/models/a.mmproj.gguf', true)).resolves.toBe('noVision');
});

it('reports a projector that reads images as vision', async () => {
  const context = contextOf(true, true);

  await expect(loadProjector(context, '/models/a.mmproj.gguf', false)).resolves.toBe('vision');
  expect(context.initMultimodal).toHaveBeenCalledWith({
    path: '/models/a.mmproj.gguf',
    use_gpu: false,
  });
});

it('throws for a refused load where verification reads image support, so the read runs again', async () => {
  await expect(
    projectorReadsImages(contextOf(false, false), '/models/a.mmproj.gguf', true)
  ).rejects.toThrow('projector');
});

it('answers false where verification reads image support for a projector that loads without vision', async () => {
  await expect(
    projectorReadsImages(contextOf(true, false), '/models/a.mmproj.gguf', true)
  ).resolves.toBe(false);
});
