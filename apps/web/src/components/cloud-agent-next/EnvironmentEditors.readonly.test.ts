import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EnvironmentScriptsEditor } from './EnvironmentScriptsEditor';
import { EnvironmentVariablesEditor } from './EnvironmentVariablesEditor';

Object.assign(globalThis, { React });

function renderScripts(readOnly: boolean): string {
  return renderToStaticMarkup(
    React.createElement(EnvironmentScriptsEditor, {
      script: 'pnpm install',
      onChange: jest.fn(),
      readOnly,
    })
  );
}

function renderVariables(readOnly: boolean): string {
  return renderToStaticMarkup(
    React.createElement(EnvironmentVariablesEditor, {
      text: 'NODE_ENV="production"\nAPI_KEY=<unchanged>',
      onChange: jest.fn(),
      removedKeys: [],
      error: null,
      readOnly,
    })
  );
}

function tag(markup: string, name: string): string {
  return markup.match(new RegExp(`<${name}[^>]*>`))?.[0] ?? '';
}

describe('EnvironmentScriptsEditor readOnly', () => {
  it('locks the script, hides the file picker, and explains the read-only view', () => {
    const markup = renderScripts(true);

    expect(tag(markup, 'textarea')).toMatch(/\sreadOnly=""/i);
    expect(tag(markup, 'input')).toMatch(/\sdisabled=""/i);
    expect(markup).not.toContain('Choose file');
    expect(markup).toContain('Runs before the agent starts.');
    expect(markup).not.toContain('For longer setup');
    expect(markup).toContain('pnpm install');
  });

  it('keeps the editor and file picker usable when editing is allowed', () => {
    const markup = renderScripts(false);

    expect(tag(markup, 'textarea')).not.toMatch(/\sreadOnly=/i);
    expect(tag(markup, 'input')).not.toMatch(/\sdisabled=""/i);
    expect(markup).toContain('Choose file');
    expect(markup).toContain('For longer setup');
  });
});

describe('EnvironmentVariablesEditor readOnly', () => {
  it('locks the textarea and describes the hidden secret values', () => {
    const markup = renderVariables(true);

    expect(tag(markup, 'textarea')).toMatch(/\sreadOnly=""/i);
    expect(markup).toContain('Secret values are hidden. Only their names are shown.');
    expect(markup).not.toContain('New and replaced values are encrypted.');
    expect(markup).toContain('NODE_ENV');
  });

  it('keeps the editing guidance when editing is allowed', () => {
    const markup = renderVariables(false);

    expect(tag(markup, 'textarea')).not.toMatch(/\sreadOnly=/i);
    expect(markup).toContain('New and replaced values are encrypted.');
    expect(markup).not.toContain('Secret values are hidden.');
  });
});
