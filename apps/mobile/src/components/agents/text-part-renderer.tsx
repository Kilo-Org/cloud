import { ScrollView, View } from 'react-native';

import { Text } from '@/components/ui/text';

type Segment =
  | { type: 'text'; content: string }
  | { type: 'code-block'; content: string; language?: string };

function parseMarkdownSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;

  let match = codeBlockRegex.exec(text);
  while (match !== null) {
    // Text before the code block
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) {
        segments.push({ type: 'text', content: before });
      }
    }
    segments.push({
      type: 'code-block',
      content: match[2] ?? '',
      language: match[1] ?? undefined,
    });
    lastIndex = match.index + match[0].length;
    match = codeBlockRegex.exec(text);
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ type: 'text', content: remaining });
    }
  }

  return segments;
}

function CodeBlock({ code, language }: Readonly<{ code: string; language?: string }>) {
  return (
    <View className="my-1 overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-900">
      {language ? (
        <Text className="px-3 pt-2 text-xs text-muted-foreground">{language}</Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable className="p-3 font-mono text-sm leading-5 text-foreground">
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

type TextPartRendererProps = {
  text: string;
};

export function TextPartRenderer({ text }: Readonly<TextPartRendererProps>) {
  if (!text) {
    return null;
  }

  const segments = parseMarkdownSegments(text);

  return (
    <View className="gap-1">
      {segments.map((segment, index) => {
        if (segment.type === 'code-block') {
          return <CodeBlock key={index} code={segment.content} language={segment.language} />;
        }
        return (
          <Text key={index} selectable className="text-base leading-6 text-foreground">
            {segment.content}
          </Text>
        );
      })}
    </View>
  );
}
