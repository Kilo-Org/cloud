export function buildAttachmentR2Key(params: {
  keyPrefix: string;
  conversationId: string;
  uploaderId: string;
  attachmentId: string;
}): string {
  const { keyPrefix, conversationId, uploaderId, attachmentId } = params;
  if (!conversationId || !uploaderId || !attachmentId) {
    throw new Error('buildAttachmentR2Key: all id segments are required');
  }
  // encodeURIComponent leaves [A-Za-z0-9-_.!~*'()] alone and percent-encodes
  // everything else, including `/`, `\`, control chars, whitespace, and
  // non-ASCII. That guarantees each segment occupies exactly one path slot in
  // the R2 key regardless of what shape future auth flows give callerId.
  return `${keyPrefix}attachments/${encodeURIComponent(conversationId)}/${encodeURIComponent(uploaderId)}/${encodeURIComponent(attachmentId)}`;
}
