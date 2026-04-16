import type { Part, FilePart, ToolPart } from './types';

function isFilePart(part: Part): part is FilePart {
  return part.type === 'file';
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool';
}

function stripFilePartContent(part: FilePart): FilePart {
  const stripped: FilePart = {
    id: part.id,
    sessionID: part.sessionID,
    messageID: part.messageID,
    type: 'file',
    mime: part.mime,
    filename: part.filename,
    url: '',
  };
  if (part.source) {
    stripped.source = {
      ...part.source,
      text: {
        ...part.source.text,
        value: '',
      },
    };
  }
  return stripped;
}

export function stripPartContentIfFile(part: Part): Part {
  if (isFilePart(part)) {
    return stripFilePartContent(part);
  }
  if (isToolPart(part) && part.state.status === 'completed' && part.state.attachments) {
    const strippedAttachments = part.state.attachments.map(stripFilePartContent);
    return {
      ...part,
      state: {
        ...part.state,
        attachments: strippedAttachments,
      },
    };
  }
  return part;
}
