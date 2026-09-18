import { describe, expect, it, vi } from 'vitest';

import { type LauncherSurfaceTargets } from '@/lib/launcher-surfaces';
import {
  buildLauncherSurfacesPayload,
  createLauncherSurfacesPublisher,
} from '@/lib/launcher-surfaces-publish';

const translate = (key: string): string => `t:${key}`;

/** A second translator, so a baked-in English label cannot pass the suite. */
const otherLanguage = (key: string): string => `<${key}>`;

function targets(over: Partial<LauncherSurfaceTargets> = {}): LauncherSurfaceTargets {
  return {
    newAgentUrl: 'kiloapp:///cloud/sessions/new',
    needsInputUrl: null,
    openLastSessionUrl: null,
    ...over,
  };
}

describe('buildLauncherSurfacesPayload', () => {
  it('labels every action and passes each target URL through unchanged', () => {
    const payload = buildLauncherSurfacesPayload(
      targets({
        needsInputUrl: 'kiloapp:///cloud/sessions/ses_wait',
        openLastSessionUrl: 'kiloapp:///cloud/sessions/ses_last',
      }),
      translate
    );
    expect(payload).toEqual({
      newAgentUrl: 'kiloapp:///cloud/sessions/new',
      newAgentLabel: 't:glanceable.newAgent',
      needsInputUrl: 'kiloapp:///cloud/sessions/ses_wait',
      needsInputLabel: 't:glanceable.needsInput',
      openLastSessionUrl: 'kiloapp:///cloud/sessions/ses_last',
      openLastSessionLabel: 't:launcher.openLastSession',
    });
  });

  it('keeps the Needs input label when nothing waits', () => {
    // The label names the tile's next state, so it must survive the
    // nothing-waiting payload that drops the shortcut URL.
    const payload = buildLauncherSurfacesPayload(targets(), translate);
    expect(payload.needsInputUrl).toBeNull();
    expect(payload.needsInputLabel).toBe('t:glanceable.needsInput');
  });

  it('translates through the supplied function, not a baked-in English label', () => {
    const payload = buildLauncherSurfacesPayload(targets(), otherLanguage);
    expect(payload.newAgentLabel).toBe('<glanceable.newAgent>');
    expect(payload.needsInputLabel).toBe('<glanceable.needsInput>');
    expect(payload.openLastSessionLabel).toBe('<launcher.openLastSession>');
  });
});

describe('createLauncherSurfacesPublisher', () => {
  it('publishes each distinct target set once', () => {
    const publish = vi.fn<(payload: unknown) => void>();
    const publisher = createLauncherSurfacesPublisher(publish, vi.fn<() => void>());
    const waiting = targets({ needsInputUrl: 'kiloapp:///cloud/sessions/ses_wait' });

    publisher.apply(targets(), translate);
    publisher.apply(waiting, translate);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(2, buildLauncherSurfacesPayload(waiting, translate));
  });

  it('does not rewrite the surface when a repeat derives an identical list', () => {
    const publish = vi.fn<(payload: unknown) => void>();
    const publisher = createLauncherSurfacesPublisher(publish, vi.fn<() => void>());
    const lastOpened = targets({ openLastSessionUrl: 'kiloapp:///cloud/sessions/ses_last' });

    publisher.apply(lastOpened, translate);
    publisher.apply(lastOpened, translate);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(buildLauncherSurfacesPayload(lastOpened, translate));
  });

  it('republishes when only a label changes', () => {
    const publish = vi.fn<(payload: unknown) => void>();
    const publisher = createLauncherSurfacesPublisher(publish, vi.fn<() => void>());

    publisher.apply(targets(), translate);
    publisher.apply(targets(), otherLanguage);

    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('clears through the injected clear and publishes again on a later apply', () => {
    const publish = vi.fn<(payload: unknown) => void>();
    const clear = vi.fn<() => void>();
    const publisher = createLauncherSurfacesPublisher(publish, clear);

    publisher.apply(targets(), translate);
    publisher.clear();

    expect(clear).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();

    // The native side dropped the surface, so the same targets must be written
    // again rather than suppressed by the pre-clear memo.
    publisher.apply(targets(), translate);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
