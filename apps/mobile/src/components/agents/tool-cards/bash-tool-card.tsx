import { View } from 'react-native';
import { Terminal } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { SelectableText } from '@/components/ui/selectable-text';
import { codeFieldTextStyle } from '@/lib/rtl-text';

import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { toolPartHasDetails } from '../tool-card-display';
import { toolStatusLabel } from '../tool-status-label';
import { useToolDisplay } from '../use-tool-display';
import { TOOL_VALUE_SURFACE_CLASS } from './value-surface';

const bashToolInputSchema = z.object({ command: z.string() });

/**
 * Sheet body for a bash tool part: the `$ command` block, the output block,
 * and the error. Renders only inside the detail sheet — attachments and the
 * pending/running status line live in `ToolPartDetailBody`.
 */
export function BashToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const command = bashToolInputSchema.safeParse(input).data?.command ?? '';
  const commandText = `$ ${command}`;

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <View className="gap-2">
      {command.length > 0 ? (
        <View className={TOOL_VALUE_SURFACE_CLASS}>
          {/* A command is code that must copy verbatim: the code field's own
              style keeps it on the left in every interface (not on the label's
              start edge) and pins its direction, which also keeps the RTL base
              mark out of the copied text (see `rtlBaseMarkedChildren`). */}
          <SelectableText
            className="font-mono text-xs leading-[1rem] text-foreground"
            style={codeFieldTextStyle()}
          >
            {commandText}
          </SelectableText>
        </View>
      ) : null}
      {output ? <MonoScrollBlock content={output} textClassName="text-muted-foreground" /> : null}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function BashToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const { t } = useTranslation();
  const display = useToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Terminal}
      label={display.subtitle ?? display.title}
      translatable={display.translatable}
      status={part.state.status}
      accessibilityLabel={t('agentChat.toolCard.accessibilityLabel', {
        name: display.subtitle ?? display.title,
        status: toolStatusLabel(t, part.state.status),
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
