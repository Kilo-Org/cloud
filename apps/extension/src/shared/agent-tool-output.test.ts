import { describe, expect, it } from 'vitest';
import { getViewportScreenshotDataUrl } from './agent-tool-output';

describe('agent tool output helpers', () => {
  it('returns the captured screenshot image only for browser screenshot results', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';

    expect(
      getViewportScreenshotDataUrl('kilo_browser_take_screenshot', {
        dataUrl,
        mediaType: 'image/png',
      })
    ).toBe(dataUrl);
    expect(getViewportScreenshotDataUrl('kilo_browser_snapshot', { dataUrl })).toBeUndefined();
    expect(
      getViewportScreenshotDataUrl('kilo_browser_take_screenshot', {
        dataUrl: 'data:image/jpeg;base64,/9j/',
        mediaType: 'image/jpeg',
      })
    ).toBeUndefined();
  });
});
