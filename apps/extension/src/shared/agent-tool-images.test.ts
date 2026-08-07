/* eslint-disable jest/no-hooks -- beforeEach resets the module-level image store */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearToolImages,
  getToolImage,
  MAX_TOOL_IMAGES,
  rememberToolImage,
} from './agent-tool-images';

describe('agent tool images', () => {
  beforeEach(() => {
    clearToolImages();
  });

  it('drops non-image mime types', () => {
    rememberToolImage('part-1', { dataUrl: 'data:text/plain;base64,SGVsbG8=', mime: 'text/plain' });
    expect(getToolImage('part-1')).toBeUndefined();
  });

  it('drops blank data URLs', () => {
    rememberToolImage('part-2', { dataUrl: '', mime: 'image/png' });
    expect(getToolImage('part-2')).toBeUndefined();
  });

  it('drops an external image URL', () => {
    rememberToolImage('part-ext', {
      dataUrl: 'https://example.com/screenshot.png',
      mime: 'image/png',
    });
    expect(getToolImage('part-ext')).toBeUndefined();
  });

  it('reads back a stored image', () => {
    rememberToolImage('part-3', { dataUrl: 'data:image/png;base64,AAA=', mime: 'image/png' });
    expect(getToolImage('part-3')).toBe('data:image/png;base64,AAA=');
  });

  it('evicts the oldest image beyond MAX_TOOL_IMAGES', () => {
    for (let index = 0; index < MAX_TOOL_IMAGES + 1; index += 1) {
      rememberToolImage(`part-${index}`, {
        dataUrl: `data:image/png;base64,${index}`,
        mime: 'image/png',
      });
    }
    expect(getToolImage('part-0')).toBeUndefined();
    for (let index = 1; index <= MAX_TOOL_IMAGES; index += 1) {
      expect(getToolImage(`part-${index}`)).toBe(`data:image/png;base64,${index}`);
    }
  });

  it('moves a re-stored image to the newest position', () => {
    for (let index = 0; index < MAX_TOOL_IMAGES; index += 1) {
      rememberToolImage(`part-${index}`, {
        dataUrl: `data:image/png;base64,${index}`,
        mime: 'image/png',
      });
    }
    rememberToolImage('part-0', {
      dataUrl: 'data:image/png;base64,renewed',
      mime: 'image/png',
    });
    rememberToolImage('part-extra', {
      dataUrl: 'data:image/png;base64,extra',
      mime: 'image/png',
    });
    expect(getToolImage('part-0')).toBe('data:image/png;base64,renewed');
    expect(getToolImage('part-1')).toBeUndefined();
  });
});
