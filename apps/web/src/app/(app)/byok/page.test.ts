/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest mocks must be registered before loading the page. */
// The personal BYOK page renders the ChatGPT connection card only when the
// PostHog flag allows it. The card's own behaviour is covered in
// `OpenAiChatGptCard.test.ts`; this locks the flag gate.
import { jest } from '@jest/globals';
import React, { createElement } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

let mockFlagEnabled: boolean | undefined = false;

jest.mock('posthog-js/react', () => ({
  useFeatureFlagEnabled: () => mockFlagEnabled,
}));

jest.mock('@/components/PageLayout', () => ({
  PageLayout: ({ children }: { children: ReactElement }) => children,
}));

jest.mock('@/components/organizations/byok/BYOKKeysManager', () => ({
  BYOKKeysManager: () => createElement('div', null, 'BYOKKeysManager'),
}));

jest.mock('@/components/organizations/byok/OpenAiChatGptCard', () => ({
  OpenAiChatGptCard: () => createElement('div', null, 'card'),
  OpenAiChatGptCardView: () => createElement('div', null, 'card-skeleton'),
}));

const { default: PersonalBYOKPage } = require('./page') as {
  default: () => ReactElement;
};

describe('PersonalBYOKPage ChatGPT flag gate', () => {
  it('hides the ChatGPT card when the flag is off', () => {
    mockFlagEnabled = false;
    const html = renderToStaticMarkup(createElement(PersonalBYOKPage));

    expect(html).not.toContain('card');
    expect(html).toContain('BYOKKeysManager');
  });

  it('holds the card height while the flag is still loading', () => {
    mockFlagEnabled = undefined;
    const html = renderToStaticMarkup(createElement(PersonalBYOKPage));

    expect(html).toContain('card-skeleton');
    expect(html).not.toMatch(/>card</);
  });

  it('shows the ChatGPT card when the flag is on', () => {
    mockFlagEnabled = true;
    const html = renderToStaticMarkup(createElement(PersonalBYOKPage));

    expect(html).toMatch(/>card</);
    expect(html).toContain('BYOKKeysManager');
  });
});
