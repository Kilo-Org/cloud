import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { toolFieldLabel } from './tool-field-label';

// The catalog loads per language, so the language changes once rather than
// passing `lng` to every call.
beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('toolFieldLabel', () => {
  it('labels a known built-in argument in the reader language', () => {
    expect(toolFieldLabel(i18n.t, 'filePath')).toBe('File path');
    expect(toolFieldLabel(i18n.t, 'offset')).toBe('Offset');
    expect(toolFieldLabel(i18n.t, 'patchText')).toBe('Patch text');
  });

  it('keeps the raw key of a tool the app does not know', () => {
    expect(toolFieldLabel(i18n.t, 'title')).toBe('title');
    expect(toolFieldLabel(i18n.t, 'team_name')).toBe('team_name');
  });

  it('translates a numbered question row and keeps its position after the label', () => {
    expect(toolFieldLabel(i18n.t, 'header 1')).toBe('Header 1');
    expect(toolFieldLabel(i18n.t, 'options 2')).toBe('Options 2');
    expect(toolFieldLabel(i18n.t, 'title 2')).toBe('title 2');
  });

  it('renders the label from the active catalog', async () => {
    await i18n.changeLanguage('hi');
    try {
      expect(toolFieldLabel(i18n.t, 'filePath')).toBe('फ़ाइल पथ');
      expect(toolFieldLabel(i18n.t, 'path')).toBe('पथ');
      expect(toolFieldLabel(i18n.t, 'title')).toBe('title');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
