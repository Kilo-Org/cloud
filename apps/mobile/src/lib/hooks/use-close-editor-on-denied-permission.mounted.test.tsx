import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useCloseEditorOnDeniedPermission } from '@/lib/hooks/use-close-editor-on-denied-permission';
import { type OrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { act } from '@/test/renderer';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

/** Every close the probe recorded, in order. */
const closes: string[] = [];

function Probe({ permission }: Readonly<{ permission: OrganizationProfilePermission }>) {
  // A fresh closure on every render is the real call site's shape, and it must
  // still close once per denial rather than once per render.
  useCloseEditorOnDeniedPermission(permission, () => {
    closes.push('close');
  });
  return null;
}

function mount(permission: OrganizationProfilePermission): Promise<RenderWithProvidersResult> {
  return renderWithProviders(createElement(Probe, { permission }));
}

describe('useCloseEditorOnDeniedPermission', () => {
  beforeEach(() => {
    closes.length = 0;
  });

  it('closes an open editor when the permission reads read-only', async () => {
    const { unmount } = await mount('read-only');

    expect(closes).toEqual(['close']);

    unmount();
  });

  it('closes on each transition into read-only, and only then', async () => {
    const { renderer, unmount } = await mount('allowed');
    expect(closes).toEqual([]);

    // A role that is not known yet is not a denial: the server may still accept
    // the save, so the editor and its draft stay.
    act(() => {
      renderer.update(createElement(Probe, { permission: 'resolving' }));
    });
    expect(closes).toEqual([]);

    act(() => {
      renderer.update(createElement(Probe, { permission: 'read-only' }));
    });
    expect(closes).toEqual(['close']);

    // Re-rendering with the same denial does not close a second time: the
    // transition is what closes, not the render.
    act(() => {
      renderer.update(createElement(Probe, { permission: 'read-only' }));
    });
    expect(closes).toEqual(['close']);

    act(() => {
      renderer.update(createElement(Probe, { permission: 'allowed' }));
    });
    act(() => {
      renderer.update(createElement(Probe, { permission: 'read-only' }));
    });
    expect(closes).toEqual(['close', 'close']);

    unmount();
  });

  it('leaves the editor open while the permission resolves or allows', async () => {
    const { renderer, unmount } = await mount('resolving');
    expect(closes).toEqual([]);

    act(() => {
      renderer.update(createElement(Probe, { permission: 'allowed' }));
    });
    expect(closes).toEqual([]);

    unmount();
  });
});