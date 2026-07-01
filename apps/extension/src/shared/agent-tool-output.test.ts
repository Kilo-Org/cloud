import { describe, expect, it } from 'vitest';
import { getViewportScreenshotDataUrl } from './agent-tool-output';

describe('agent tool output helpers', () => {
  it('returns the captured screenshot image only for viewport screenshot results', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';

    expect(
      getViewportScreenshotDataUrl('get_viewport_screenshot', {
        dataUrl,
        mediaType: 'image/png',
      })
    ).toBe(dataUrl);
    expect(getViewportScreenshotDataUrl('get_page_snapshot', { dataUrl })).toBeUndefined();
    expect(
      getViewportScreenshotDataUrl('get_viewport_screenshot', {
        dataUrl: 'data:image/jpeg;base64,/9j/',
        mediaType: 'image/jpeg',
      })
    ).toBeUndefined();
  });
});
