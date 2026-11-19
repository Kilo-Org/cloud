import { type ComponentProps, type ReactNode } from 'react';

import { Text } from '@/components/ui/text';
import { splitInlineCode } from '@/i18n/plain-copy';

type InlineCodeTextProps = Omit<ComponentProps<typeof Text>, 'children'> & {
  /** Catalog copy that may mark a command or a path with backticks. */
  value: string;
  /** The mono run's own color, for a paragraph that is not `foreground`. */
  codeClassName?: string;
};

/**
 * Catalog copy as one paragraph, with each backticked command or path drawn in
 * the mono style the rest of the app uses for literals. The run keeps its own
 * bidi isolation and no-break space (`splitInlineCode`), so a right-to-left
 * sentence still reads the command in one order.
 *
 * The run takes `codeClassName` because a nested `Text` carries its own color:
 * without it a mono command inside muted copy would brighten to `foreground`.
 */
export function InlineCodeText({ value, codeClassName, ...props }: Readonly<InlineCodeTextProps>) {
  const segments = splitInlineCode(value);
  const children: ReactNode[] = segments.map((segment, index) =>
    segment.code ? (
      <Text key={index} variant="mono" className={codeClassName}>
        {segment.text}
      </Text>
    ) : (
      segment.text
    )
  );
  return <Text {...props}>{children}</Text>;
}
