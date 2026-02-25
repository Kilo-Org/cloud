'use client';

import { useState } from 'react';
import Image from 'next/image';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EDITOR_OPTIONS, DEFAULT_EDITOR, type EditorOption } from '@/lib/editorOptions';
import { EDITOR_SOURCE_COOKIE_NAME } from '@/lib/editorSource.client';

const validEditorOptions = EDITOR_OPTIONS.filter(
  editor => editor.visibilityOnInstallPage !== 'hide' || editor.source === 'idea'
);

const setCookie = (name: string, value: string) => {
  document.cookie = `${name}=${value}; path=/; max-age=31536000`;
};

type Props = {
  sessionId: string;
  defaultEditor?: EditorOption;
  pathOverride?: string;
};

export function OpenInEditorButton({ sessionId, defaultEditor, pathOverride }: Props) {
  const [preferredEditor, setPreferredEditor] = useState<EditorOption>(
    defaultEditor ?? DEFAULT_EDITOR
  );

  const buildUrl = (editor: EditorOption) =>
    pathOverride
      ? `${editor.scheme}://${editor.host}${editor.path}${pathOverride}`
      : `${editor.scheme}://${editor.host}${editor.path}/fork?id=${sessionId}`;

  const handleEditorClick = (editor: EditorOption) => {
    setCookie(EDITOR_SOURCE_COOKIE_NAME, editor.source);
    setPreferredEditor(editor);
  };

  return (
    <div className="inline-flex rounded-md">
      <Button asChild variant="outline" className="rounded-r-none border-r-0">
        <a
          href={buildUrl(preferredEditor)}
          onClick={() => handleEditorClick(preferredEditor)}
          className="inline-flex items-center gap-2"
        >
          <Image
            src={preferredEditor.logoSrc}
            alt={preferredEditor.alt}
            className="aspect-square"
            height={20}
            width={20}
          />
          Open in {preferredEditor.name}
        </a>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="rounded-l-none px-2" aria-label="Select editor">
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {validEditorOptions
            .filter(e => e.source !== preferredEditor.source)
            .map(editor => (
              <DropdownMenuItem key={editor.source} asChild>
                <a
                  href={buildUrl(editor)}
                  onClick={() => handleEditorClick(editor)}
                  className="inline-flex cursor-pointer items-center gap-2"
                >
                  <Image
                    src={editor.logoSrc}
                    alt={editor.alt}
                    className="aspect-square"
                    height={16}
                    width={16}
                  />
                  {editor.name}
                </a>
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
