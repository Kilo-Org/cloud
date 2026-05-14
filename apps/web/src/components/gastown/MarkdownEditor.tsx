'use client';

import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  BoldItalicUnderlineToggles,
  UndoRedo,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';

type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

export function MarkdownEditor({ value, onChange, placeholder }: MarkdownEditorProps) {
  return (
    <div className="mdx-editor-dark relative min-h-[300px] overflow-hidden rounded-lg border border-white/[0.08] bg-black/20">
      <style>{`
        .mdx-editor-dark .mdxeditor {
          background: transparent;
          font-family: inherit;
          min-height: 300px;
        }
        .mdx-editor-dark [class*="contentEditable"] {
          min-height: 260px;
          padding: 12px 16px;
        }
      `}</style>
      <MDXEditor
        className="dark-theme"
        markdown={value}
        onChange={onChange}
        placeholder={placeholder}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BoldItalicUnderlineToggles />
              </>
            ),
          }),
        ]}
      />
    </div>
  );
}
