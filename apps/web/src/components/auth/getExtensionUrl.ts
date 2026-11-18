import { EDITOR_OPTIONS, DEFAULT_EDITOR } from '@/lib/editorOptions';
import { EDITOR_SOURCE_COOKIE_NAME } from '@/lib/editorSource.client';

type Cookies = {
  get: (name: string) => { value: string } | undefined;
};

export function getExtensionUrl(searchParams: NextAppSearchParams, cookies: Cookies) {
  const sourceParam = searchParams?.source;
  const urlParam =
    (Array.isArray(searchParams.path) ? searchParams.path[0] : searchParams.path) || '';
  const path = urlParam ? `/${encodeURIComponent(urlParam)}` : '';
  const source =
    (Array.isArray(sourceParam) ? sourceParam[0] : sourceParam) ||
    cookies?.get(EDITOR_SOURCE_COOKIE_NAME)?.value ||
    DEFAULT_EDITOR.source;

  const editor = EDITOR_OPTIONS.find(editor => editor.source === source);

  if (editor) {
    const urlScheme = editor.scheme;
    const urlHost = editor.host;
    const urlPath = editor.path;
    const extensionUrl = `${urlScheme}://${urlHost}${urlPath}${path}`;

    return {
      urlScheme,
      ideName: editor.name,
      extensionUrl,
      logoSrc: editor.logoSrc,
      editor,
    };
  }

  if (source === 'web') {
    return {
      urlScheme: 'web',
      ideName: 'Web',
      extensionUrl: '',
      logoSrc: undefined,
      editor: DEFAULT_EDITOR,
    };
  }

  const urlScheme = DEFAULT_EDITOR.scheme;
  const urlHost = DEFAULT_EDITOR.host;
  const urlPath = DEFAULT_EDITOR.path;
  const extensionUrl = `${urlScheme}://${urlHost}${urlPath}${path}`;

  return {
    urlScheme,
    ideName: DEFAULT_EDITOR.name,
    extensionUrl,
    logoSrc: DEFAULT_EDITOR.logoSrc,
    editor: DEFAULT_EDITOR,
  };
}
