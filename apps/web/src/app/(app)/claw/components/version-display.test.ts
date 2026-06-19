import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VersionImageMetadata } from './VersionPinCard';

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
    // Different OpenClaw versions: no "same version" explanation.
    expect(html).not.toContain('the same OpenClaw version');
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

    expect(html).toContain(
      'Both images run the same OpenClaw version, but the latest image includes additional fixes, improvements, and features.'
    );
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

    expect(html).not.toContain('the same OpenClaw version');
  });
});
