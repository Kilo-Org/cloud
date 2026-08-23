import { View } from 'react-native';
import { FilePlus } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { SelectableText } from '@/components/ui/selectable-text';
import { Text } from '@/components/ui/text';
import { languageForPath } from '@/lib/pr-review/diff/highlight';

import { CodeBlock } from '../code-block';
import { FixedPartRow } from '../fixed-part-row';
import { useOpenPartDetail } from '../open-part-detail-context';
import { ReadMarkdownBody } from '../read-markdown-body';
import { isMarkdownPath } from '../read-tool-markdown';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';

const WRITE_CODE_CHARACTER_CAP = 50_000;

const optionalStringSchema = z.string().optional();

/**
 * Sheet body for a write tool part: markdown or highlighted code from
 * `input.content`, plus the error. Diff preview is gone. Renders only inside
 * the detail sheet — attachments and the pending/running status line live in
 * `ToolPartDetailBody`.
 */
export function WriteToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const { t } = useTranslation();
  const input = part.state.input;
  const filePath = optionalStringSchema.safeParse(input.filePath).data ?? '';
  const content = optionalStringSchema.safeParse(input.content).data ?? '';
  const error = part.state.status === 'error' ? part.state.error : undefined;
  const isFinal = part.state.status === 'completed' || part.state.status === 'error';

  let body: React.ReactNode = null;
  if (content === '' && !isFinal) {
    // Pending or running: the write has not finished, so the file is not yet
    // known to be empty. `ToolPartDetailBody` already shows the status line.
  } else if (isMarkdownPath(filePath)) {
    body = <ReadMarkdownBody body={{ text: content, footer: undefined }} />;
  } else if (content === '') {
    body = (
      <Text className="text-xs text-muted-foreground">{t('agentChat.toolCard.fileEmpty')}</Text>
    );
  } else {
    body = (
      <CodeBlock
        code={content}
        language={languageForPath(filePath)}
        maxLength={WRITE_CODE_CHARACTER_CAP}
      />
    );
  }

  return (
    <View className="gap-2">
      {body}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function WriteToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const { t } = useTranslation();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={FilePlus}
      label={display.subtitle ?? display.title}
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
