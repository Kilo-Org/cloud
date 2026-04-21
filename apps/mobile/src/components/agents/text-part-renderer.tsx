import { MarkdownText } from './markdown-text';

type TextPartRendererProps = {
  text: string;
};

export function TextPartRenderer({ text }: Readonly<TextPartRendererProps>) {
  if (!text) {
    return null;
  }

  return <MarkdownText value={text} variant="assistant" />;
}
