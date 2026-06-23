import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VersionImageMetadata } from './VersionPinCard';

// The same-version explanation is surfaced as the info trigger's accessible
// name (aria-label), which renders into static markup. We deliberately assert
// against the aria-label rather than the Radix TooltipContent: that content
// lives in a portal and only mounts when the tooltip is open, so it never
// appears in renderToStaticMarkup output.
const SAME_VERSION_EXPLANATION =
  'Both images run the same OpenClaw version, but the latest image includes additional fixes, improvements, and features.';
const SAME_VERSION_ARIA_LABEL = `aria-label="${SAME_VERSION_EXPLANATION}"`;

describe('KiloClaw version display', () => {
  it('pairs current and latest OpenClaw versions with their image tags', () => {
    const html = renderToStaticMarkup(
      createElement(
        'table',
        null,
        createElement(
          'tbody',
          null,
          createElement(VersionImageMetadata, {
            currentOpenClawVersion: '2026.6.5',
            trackedImageTag: 'img-5f02b9408089',
            latestOpenClawVersion: '2026.6.8',
            latestImageTag: 'img-048842db6829',
          })
        )
      )
    );

    expect(html).toContain('Active');
    expect(html).toContain('OpenClaw 2026.6.5');
    expect(html).toContain('img-5f02b9408089');
    expect(html).toContain('Latest');
    expect(html).toContain('OpenClaw 2026.6.8');
    expect(html).toContain('img-048842db6829');
    // Different OpenClaw versions: no "same version" explanation trigger.
    expect(html).not.toContain(SAME_VERSION_ARIA_LABEL);
  });

  it('explains when active and latest share an OpenClaw version but differ by image', () => {
    const html = renderToStaticMarkup(
      createElement(
        'table',
        null,
        createElement(
          'tbody',
          null,
          createElement(VersionImageMetadata, {
            currentOpenClawVersion: '2026.6.8',
            trackedImageTag: 'img-5f02b9408089',
            latestOpenClawVersion: '2026.6.8',
            latestImageTag: 'img-048842db6829',
          })
        )
      )
    );

    expect(html).toContain(SAME_VERSION_ARIA_LABEL);
  });

  it('omits the explanation when active and latest are the same image', () => {
    const html = renderToStaticMarkup(
      createElement(
        'table',
        null,
        createElement(
          'tbody',
          null,
          createElement(VersionImageMetadata, {
            currentOpenClawVersion: '2026.6.8',
            trackedImageTag: 'img-048842db6829',
            latestOpenClawVersion: '2026.6.8',
            latestImageTag: 'img-048842db6829',
          })
        )
      )
    );

    expect(html).not.toContain(SAME_VERSION_ARIA_LABEL);
  });
});
