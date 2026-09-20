import { type ComponentProps } from 'react';
import { Text as RNText } from 'react-native';

import { Text } from '@/components/ui/text';
import { splitInlineCode } from '@/lib/inline-code';

type InlineCodeTextProps = Omit<ComponentProps<typeof Text>, 'children'> & {
  /** Catalog copy whose `backtick` spans render as inline code. */
  value: string;
};

/**
 * Body copy that renders its `backtick` command names as inline code.
 *
 * The remote-CLI help strings mark commands with backticks. They used to go
 * through a plain `Text`, so the reader saw the tick marks (`kilo remote`)
 * instead of a distinction between prose and the command to run. A span keeps
 * the surrounding size and switches to the app's mono face with the foreground
 * ink and muted chip background the transcript's own inline code uses
 * (`getMarkdownStyles.codespan`), so the command names read the same way they
 * already do in chat. The copy stays untouched in the catalogs: the marker is
 * the only shared contract across all 87 of them.
 *
 * The span is a raw React Native `Text`, nested inside the shared one on
 * purpose: nesting is what keeps the surrounding size and inherits the
 * paragraph direction the shared component sets, so it stays correct in RTL
 * unlike a top-level bare `Text`.
 */
export function InlineCodeText({ value, ...textProps }: Readonly<InlineCodeTextProps>) {
  return (
    <Text {...textProps}>
      {splitInlineCode(value).map((segment, index) =>
        segment.code ? (
          <RNText
            key={`inline-code-${index}`}
            className="bg-muted font-mono-medium text-foreground"
          >
            {segment.value}
          </RNText>
        ) : (
          segment.value
        )
      )}
    </Text>
  );
}
