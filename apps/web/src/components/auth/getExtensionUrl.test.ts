import { getExtensionUrl } from './getExtensionUrl';
import { EDITOR_OPTIONS, DEFAULT_EDITOR } from '@/lib/editorOptions';

describe('getExtensionUrl', () => {
  const noCookies = { get: (_name: string) => undefined };

  it.each(EDITOR_OPTIONS.map(editor => [editor.source, editor]))(
    'resolves source %s to that editor entry',
    (source, editor) => {
      const result = getExtensionUrl({ source }, noCookies);

      expect(result.urlScheme).toBe(editor.scheme);
      expect(result.ideName).toBe(editor.name);
      expect(result.logoSrc).toBe(editor.logoSrc);
      expect(result.editor).toBe(editor);
      expect(result.extensionUrl).toBe(`${editor.scheme}://${editor.host}${editor.path}`);
    }
  );

  it('falls back to the default editor for an unknown source value', () => {
    const result = getExtensionUrl({ source: 'not-an-editor' }, noCookies);

    expect(result.urlScheme).toBe(DEFAULT_EDITOR.scheme);
    expect(result.ideName).toBe(DEFAULT_EDITOR.name);
    expect(result.logoSrc).toBe(DEFAULT_EDITOR.logoSrc);
    expect(result.editor).toBe(DEFAULT_EDITOR);
    expect(result.extensionUrl).toBe(
      `${DEFAULT_EDITOR.scheme}://${DEFAULT_EDITOR.host}${DEFAULT_EDITOR.path}`
    );
  });

  it('falls back to the default editor when the cookie holds an unknown source value', () => {
    const cookies = { get: (name: string) => ({ value: 'not-an-editor' }) };
    const result = getExtensionUrl({}, cookies);

    expect(result.editor).toBe(DEFAULT_EDITOR);
    expect(result.urlScheme).toBe(DEFAULT_EDITOR.scheme);
  });

  it('uses the cookie value when the query has no source', () => {
    const cookies = { get: (name: string) => ({ value: 'cursor' }) };
    const result = getExtensionUrl({}, cookies);

    expect(result.editor).toBe(EDITOR_OPTIONS.find(editor => editor.source === 'cursor'));
  });

  it('keeps the explicit web flow', () => {
    const result = getExtensionUrl({ source: 'web' }, noCookies);

    expect(result.urlScheme).toBe('web');
    expect(result.ideName).toBe('Web');
    expect(result.logoSrc).toBeUndefined();
  });

  it('defaults to the default editor without a source or cookie', () => {
    const result = getExtensionUrl({}, noCookies);

    expect(result.editor).toBe(DEFAULT_EDITOR);
    expect(result.ideName).toBe(DEFAULT_EDITOR.name);
  });

  it('encodes the path parameter into the extension URL', () => {
    const result = getExtensionUrl({ source: 'vscode', path: 'profile' }, noCookies);
    const vscode = EDITOR_OPTIONS.find(editor => editor.source === 'vscode');

    expect(result.extensionUrl).toBe(`${vscode!.scheme}://${vscode!.host}${vscode!.path}/profile`);
  });

  it('encodes unsafe characters in the path parameter', () => {
    const result = getExtensionUrl({ source: 'vscode', path: 'a b&c=d' }, noCookies);
    const vscode = EDITOR_OPTIONS.find(editor => editor.source === 'vscode');

    expect(result.extensionUrl).toBe(
      `${vscode!.scheme}://${vscode!.host}${vscode!.path}/a%20b%26c%3Dd`
    );
  });
});
