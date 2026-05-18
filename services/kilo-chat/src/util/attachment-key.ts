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
  return `${keyPrefix}attachments/${conversationId}/${uploaderId}/${attachmentId}`;
}
