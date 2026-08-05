import { View } from 'react-native';
import { Eye } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { ReadMarkdownPreview } from '../read-markdown-preview';
import { isMarkdownPath, resolveMarkdownPreview } from '../read-tool-markdown';
import { getToolImageAttachments } from '../tool-card-attachments';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';

/**
 * Sheet body for a read tool part: the markdown preview for markdown paths,
 * else the output block (skipped for image reads), plus the error. Image
 * attachments render above via `ToolPartDetailBody`. Renders only inside the
 * detail sheet — the pending/running status line lives in `ToolPartDetailBody`.
 */
export function ReadToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;
  const markdownPreview = isMarkdownPath(filePath) ? resolveMarkdownPreview(part) : undefined;
  const hasImages = getToolImageAttachments(part).length > 0;

  return (
    <View className="gap-2">
      {markdownPreview ? <ReadMarkdownPreview preview={markdownPreview} /> : null}
      {/* An image read's output is only "Image read successfully" — the image itself
          is the content, so the mono block would be noise (plan D10). */}
      {markdownPreview === undefined && !hasImages && output ? (
        <MonoScrollBlock content={output} textClassName="text-foreground" />
      ) : null}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function ReadToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Eye}
      label={display.subtitle ?? display.title}
      {...(display.badge ? { badge: display.badge } : {})}
      status={part.state.status}
      accessibilityLabel={`${display.subtitle ?? display.title} tool, ${part.state.status}`}
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
