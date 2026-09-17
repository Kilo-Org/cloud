/* eslint-disable @typescript-eslint/no-require-imports -- The module builds JSX at import time and needs the global React shim set first. */
import { describe, expect, test } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const {
  AllAuthMethodIds,
  AuthProviderIdSchema,
  LinkableAuthProviders,
  OAuthProviderIds,
  ProdNonSSOAuthProviders,
  getProviderById,
} = require('./provider-metadata') as typeof import('./provider-metadata');

describe('Anaconda provider metadata', () => {
  test('defines Anaconda as a linkable OAuth sign-in method', () => {
    expect(AuthProviderIdSchema.parse('anaconda')).toBe('anaconda');
    expect(getProviderById('anaconda')).toMatchObject({
      id: 'anaconda',
      name: 'Anaconda',
    });
    expect(LinkableAuthProviders[0]?.id).toBe('anaconda');
    expect(OAuthProviderIds[0]).toBe('anaconda');
    expect(ProdNonSSOAuthProviders[0]).toBe('anaconda');
    expect(AllAuthMethodIds).toContain('anaconda');
  });
});

describe('OpenAI provider metadata', () => {
  test('defines ChatGPT as a linkable OAuth sign-in method', () => {
    expect(AuthProviderIdSchema.parse('openai')).toBe('openai');
    expect(getProviderById('openai')).toMatchObject({
      id: 'openai',
      name: 'ChatGPT',
      signInLabel: 'Sign in with ChatGPT',
    });
    expect(OAuthProviderIds).toContain('openai');
    expect(ProdNonSSOAuthProviders).toContain('openai');
    expect(AllAuthMethodIds).toContain('openai');
  });

  test('renders the OpenAI logo beside the ChatGPT sign-in label', () => {
    const html = renderToStaticMarkup(getProviderById('openai').icon);

    expect(html).toContain('OpenAI logo');
  });
});
