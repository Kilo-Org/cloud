'use client';

import { Suspense, lazy, useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';

const Editor = lazy(() => import('@monaco-editor/react'));

type MonacoJsonEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  height?: string;
};

function EditorLoading() {
  return (
    <div className="bg-muted flex min-h-[200px] items-center justify-center rounded-md border">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading editor...
      </div>
    </div>
  );
}

export function MonacoJsonEditor({
  value,
  onChange,
  placeholder,
  height = '200px',
}: MonacoJsonEditorProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return <EditorLoading />;
  }

  return (
    <Suspense fallback={<EditorLoading />}>
      <div className="overflow-hidden rounded-md border">
        <Editor
          height={height}
          defaultLanguage="json"
          value={value || placeholder}
          onChange={newValue => onChange(newValue ?? '')}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            lineNumbers: 'off',
            folding: false,
            wordWrap: 'on',
            automaticLayout: true,
            tabSize: 2,
            padding: { top: 8, bottom: 8 },
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            scrollbar: {
              vertical: 'auto',
              horizontal: 'hidden',
              verticalScrollbarSize: 8,
            },
          }}
        />
      </div>
    </Suspense>
  );
}
