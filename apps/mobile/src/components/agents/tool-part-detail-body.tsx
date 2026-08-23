import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

import { getToolFileAttachments, getToolImageAttachments } from './tool-card-attachments';
import { ToolCardFileAttachments } from './tool-card-file-attachments';
import { ToolCardImageAttachments } from './tool-card-image-attachments';
import {
  BashToolCardBody,
  EditToolCardBody,
  GenericToolCardBody,
  GlobToolCardBody,
  GrepToolCardBody,
  ListToolCardBody,
  PatchToolCardBody,
  ReadToolCardBody,
  TaskToolCardBody,
  TodoToolCardBody,
  WebSearchToolCardBody,
  WriteToolCardBody,
} from './tool-cards';

function renderToolBody(part: ToolPart): React.ReactNode {
  switch (part.tool) {
    case 'read': {
      return <ReadToolCardBody part={part} />;
    }
    case 'edit': {
      return <EditToolCardBody part={part} />;
    }
    case 'write': {
      return <WriteToolCardBody part={part} />;
    }
    case 'bash': {
      return <BashToolCardBody part={part} />;
    }
    case 'glob': {
      return <GlobToolCardBody part={part} />;
    }
    case 'grep': {
      return <GrepToolCardBody part={part} />;
    }
    case 'websearch':
    case 'codesearch':
    case 'webfetch': {
      return <WebSearchToolCardBody part={part} />;
    }
    case 'list': {
      return <ListToolCardBody part={part} />;
    }
    case 'patch':
    case 'apply_patch': {
      return <PatchToolCardBody part={part} />;
    }
    case 'todoread':
    case 'todowrite': {
      return <TodoToolCardBody part={part} />;
    }
    case 'task': {
      return <TaskToolCardBody part={part} />;
    }
    case 'suggest': {
      return null;
    }
    default: {
      return <GenericToolCardBody part={part} />;
    }
  }
}

/**
 * Sheet body dispatcher for a tool part. Renders a uniform pending/running
 * status line, the attachments above the per-tool body, then the type-specific
 * body. Suggest parts have no body; unknown tools use the generic body.
 */
export function ToolPartDetailBody({ part }: Readonly<{ part: ToolPart }>) {
  const { t } = useTranslation();
  const status = part.state.status;

  return (
    <View className="gap-2">
      {status === 'pending' ? (
        <Text className="text-xs text-muted-foreground">{t('agentChat.partDetail.pending')}</Text>
      ) : null}
      {status === 'running' ? (
        <Text className="text-xs text-muted-foreground">{t('agentChat.partDetail.running')}</Text>
      ) : null}
      {getToolImageAttachments(part).length > 0 ? <ToolCardImageAttachments part={part} /> : null}
      {getToolFileAttachments(part).length > 0 ? <ToolCardFileAttachments part={part} /> : null}
      {renderToolBody(part)}
    </View>
  );
}
