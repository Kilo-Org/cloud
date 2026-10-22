import type { EditorOption } from '@/lib/editorOptions';

export function buildOpenInEditorUrl(
  editor: EditorOption,
  sessionId: string,
  pathOverride?: string
): string {
  return pathOverride
    ? `${editor.scheme}://${editor.host}${editor.path}${pathOverride}`
    : `${editor.scheme}://${editor.host}${editor.path}/fork?id=${sessionId}`;
}
