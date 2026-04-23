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
          --accentBase: oklch(0.95 0.15 108);
          --accentBgSubtle: oklch(0.95 0.15 108 / 0.08);
          --accentBgHover: oklch(0.95 0.15 108 / 0.12);
          --baseBase: rgba(255,255,255,0.75);
          --baseBgSubtle: rgba(255,255,255,0.03);
          --baseBgHover: rgba(255,255,255,0.05);
          background: transparent;
          color: rgba(255,255,255,0.75);
          font-family: inherit;
          min-height: 300px;
        }
        .mdx-editor-dark [class*="toolbar"] {
          background: rgba(255,255,255,0.03);
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .mdx-editor-dark [class*="toolbarRoot"] {
          background: rgba(255,255,255,0.03);
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .mdx-editor-dark [class*="ToolbarRoot"] {
          background: rgba(255,255,255,0.03);
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .mdx-editor-dark button[class*="toolbarToggleItem"],
        .mdx-editor-dark button[class*="ToolbarToggleItem"] {
          color: rgba(255,255,255,0.5);
        }
        .mdx-editor-dark button[class*="toolbarToggleItem"]:hover,
        .mdx-editor-dark button[class*="ToolbarToggleItem"]:hover {
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.8);
        }
        .mdx-editor-dark [class*="contentEditable"] {
          color: rgba(255,255,255,0.75);
          min-height: 260px;
          padding: 12px 16px;
        }
        .mdx-editor-dark [class*="contentEditable"] p.is-editor-empty:first-child::before {
          color: rgba(255,255,255,0.3);
        }
      `}</style>
      <MDXEditor
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
