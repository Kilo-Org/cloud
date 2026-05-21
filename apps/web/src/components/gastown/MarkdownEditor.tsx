'use client';

import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  markdownShortcutPlugin,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';

type MarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
};

export function MarkdownEditor({ value, onChange, placeholder, className }: MarkdownEditorProps) {
  return (
    <div
      className={`mdx-editor-dark relative min-h-[300px] overflow-hidden rounded-lg border border-white/[0.08] bg-black/20 ${className ?? ''}`}
    >
      <style>{`
        .mdx-editor-dark .mdxeditor {
          background: transparent;
          font-family: inherit;
          min-height: 300px;
          height: 100%;
        }
        .mdx-editor-dark [class*="contentEditable"] {
          min-height: 260px;
          height: 100%;
          padding: 12px 16px;
        }
        .mdx-editor-dark [contenteditable="true"] {
          color: rgba(255, 255, 255, 0.82);
          line-height: 1.6;
          outline: none;
        }
        .mdx-editor-dark [contenteditable="true"] h1,
        .mdx-editor-dark [contenteditable="true"] h2,
        .mdx-editor-dark [contenteditable="true"] h3,
        .mdx-editor-dark [contenteditable="true"] h4,
        .mdx-editor-dark [contenteditable="true"] h5,
        .mdx-editor-dark [contenteditable="true"] h6 {
          margin: 1rem 0 0.5rem;
          color: rgba(255, 255, 255, 0.94);
          font-weight: 650;
          line-height: 1.2;
        }
        .mdx-editor-dark [contenteditable="true"] h1 {
          font-size: 1.5rem;
        }
        .mdx-editor-dark [contenteditable="true"] h2 {
          font-size: 1.25rem;
        }
        .mdx-editor-dark [contenteditable="true"] h3 {
          font-size: 1.0625rem;
        }
        .mdx-editor-dark [contenteditable="true"] p {
          margin: 0.625rem 0;
        }
        .mdx-editor-dark [contenteditable="true"] ul,
        .mdx-editor-dark [contenteditable="true"] ol {
          margin: 0.625rem 0;
          padding-left: 1.5rem;
        }
        .mdx-editor-dark [contenteditable="true"] ul {
          list-style: disc;
        }
        .mdx-editor-dark [contenteditable="true"] ol {
          list-style: decimal;
        }
        .mdx-editor-dark [contenteditable="true"] li {
          display: list-item;
          margin: 0.25rem 0;
          padding-left: 0.125rem;
        }
        .mdx-editor-dark [contenteditable="true"] blockquote {
          margin: 0.75rem 0;
          border-left: 2px solid rgba(255, 255, 255, 0.16);
          padding-left: 0.75rem;
          color: rgba(255, 255, 255, 0.6);
        }
      `}</style>
      <MDXEditor
        className="dark-theme"
        markdown={value}
        onChange={onChange}
        placeholder={placeholder}
        plugins={[headingsPlugin(), listsPlugin(), quotePlugin(), markdownShortcutPlugin()]}
      />
    </div>
  );
}
