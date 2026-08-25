import { type ReactNode } from 'react';
import { View } from 'react-native';
import { Eye } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { i18n } from '@/i18n';
import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';
import { languageForPath } from '@/lib/pr-review/diff/highlight';

import { CodeBlock } from '../code-block';
import { FixedPartRow } from '../fixed-part-row';
import { useOpenPartDetail } from '../open-part-detail-context';
import { ReadMarkdownBody } from '../read-markdown-body';
import {
  isMarkdownPath,
  type ReadCodeBody,
  resolveMarkdownBody,
  resolveReadCodeBody,
} from '../read-tool-markdown';
import { getToolImageAttachments } from '../tool-card-attachments';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';

// A completed code read can exceed what a detail sheet renders comfortably;
// the cap keeps highlighting and layout bounded, and the hit shows the shared
// Truncated marker. 50k chars matches the markdown fence cap.
const READ_CODE_CHARACTER_CAP = 50_000;

const readToolInputSchema = z.object({ filePath: z.string() });

/**
 * The code body per the read precedence chain: a parseable display (empty
 * text → the muted empty line, else highlighted CodeBlock + footer), else the
 * raw output as a highlighted CodeBlock. Returns null when neither exists.
 */
function renderReadCodeBody(
  codeBody: ReadCodeBody | undefined,
  output: string | undefined,
  filePath: string
): ReactNode | null {
  if (codeBody) {
    if (codeBody.text === '') {
      return (
        <Text className="text-xs text-muted-foreground">
          {i18n.t('agentChat.toolCard.fileEmpty')}
        </Text>
      );
    }
    return (
      <View className="gap-2">
        <CodeBlock
          code={codeBody.text}
          language={languageForPath(codeBody.path || filePath)}
          maxLength={READ_CODE_CHARACTER_CAP}
        />
        {codeBody.footer ? (
          <Text className="text-xs text-muted-foreground">{codeBody.footer}</Text>
        ) : null}
      </View>
    );
  }
  if (output) {
    return (
      <CodeBlock
        code={output}
        language={languageForPath(filePath)}
        maxLength={READ_CODE_CHARACTER_CAP}
      />
    );
  }
  return null;
}

/**
 * Sheet body for a read tool part: the markdown body for markdown paths, the
 * highlighted code body for other files (skipped for image reads), plus the
 * error. Image attachments render above via `ToolPartDetailBody`. Renders only
 * inside the detail sheet — the pending/running status line lives in
 * `ToolPartDetailBody`.
 */
export function ReadToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const filePath = readToolInputSchema.safeParse(input).data?.filePath ?? '';

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;
  const markdownBody = isMarkdownPath(filePath) ? resolveMarkdownBody(part) : undefined;
  const codeBody = resolveReadCodeBody(part);
  const hasImages = getToolImageAttachments(part).length > 0;

  return (
    <View className="gap-2">
      {markdownBody ? <ReadMarkdownBody body={markdownBody} /> : null}
      {/* An image read's output is only "Image read successfully" — the image itself
          is the content, so the code body would be noise. */}
      {markdownBody === undefined && !hasImages
        ? renderReadCodeBody(codeBody, output, filePath)
        : null}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function ReadToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const { t } = useTranslation();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Eye}
      label={display.subtitle ?? display.title}
      {...(display.badge ? { badge: display.badge } : {})}
      status={part.state.status}
      accessibilityLabel={t('agentChat.toolCard.accessibilityLabel', {
        name: display.subtitle ?? display.title,
        status: part.state.status,
      })}
      onPress={
        hasDetails && openPartDetail
          ? () => {
              openPartDetail(part.id);
            }
          : undefined
      }
    />
  );
}
