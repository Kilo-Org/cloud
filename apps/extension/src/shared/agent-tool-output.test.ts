import { describe, expect, it } from 'vitest';
import { getViewportScreenshotDataUrl } from './agent-tool-output';

describe('agent tool output helpers', () => {
  it('returns the captured screenshot image for every browser_take_screenshot image type', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const jpeg = 'data:image/jpeg;base64,/9j/';
    const webp = 'data:image/webp;base64,UklGRg==';

    expect(
      getViewportScreenshotDataUrl('kilo_browser_take_screenshot', {
        dataUrl: png,
        mediaType: 'image/png',
      })
    ).toBe(png);
    expect(
      getViewportScreenshotDataUrl('kilo_browser_take_screenshot', {
        dataUrl: jpeg,
        mediaType: 'image/jpeg',
      })
    ).toBe(jpeg);
    expect(
      getViewportScreenshotDataUrl('kilo_browser_take_screenshot', {
        dataUrl: webp,
        mediaType: 'image/webp',
      })
    ).toBe(webp);
    expect(getViewportScreenshotDataUrl('kilo_browser_snapshot', { dataUrl: png })).toBeUndefined();
    expect(
      getViewportScreenshotDataUrl('kilo_browser_take_screenshot', {
        dataUrl: 'data:text/plain;base64,aGk=',
        mediaType: 'text/plain',
      })
    ).toBeUndefined();
  });
});
