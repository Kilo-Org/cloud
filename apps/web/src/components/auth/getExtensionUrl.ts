import { EDITOR_OPTIONS, DEFAULT_EDITOR } from '@/lib/editorOptions';
import { EDITOR_SOURCE_COOKIE_NAME } from '@/lib/editorSource.client';

type Cookies = {
  get: (name: string) => { value: string } | undefined;
};

export function getExtensionUrl(searchParams: NextAppSearchParams, cookies: Cookies) {
  const sourceParam = searchParams?.source;
  const urlParam =
    (Array.isArray(searchParams.path) ? searchParams.path[0] : searchParams.path) || '';
  const path = urlParam ? `/${urlParam}` : '';
  const source =
    (Array.isArray(sourceParam) ? sourceParam[0] : sourceParam) ||
    cookies?.get(EDITOR_SOURCE_COOKIE_NAME)?.value ||
    DEFAULT_EDITOR.source;

  const editor = EDITOR_OPTIONS.find(editor => editor.source === source);

  const ideName = editor ? editor.name : source.charAt(0).toUpperCase() + source.slice(1);

  const urlScheme = editor ? editor.scheme : source;
  const urlHost = editor ? editor.host : DEFAULT_EDITOR.host;
  const urlPath = editor ? editor.path : DEFAULT_EDITOR.path;
  const extensionUrl = `${urlScheme}://${urlHost}${urlPath}${path}`;

  return {
    urlScheme,
    ideName,
    extensionUrl,
    logoSrc: editor?.logoSrc,
    editor: editor || DEFAULT_EDITOR,
  };
}
