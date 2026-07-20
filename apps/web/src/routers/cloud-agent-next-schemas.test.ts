import { describe, expect, it } from '@jest/globals';
import {
  cloudAgentGetAttachmentDownloadUrlSchema,
  cloudAgentGetAttachmentUploadUrlSchema,
  cloudAgentRelaxedAttachmentFilenameSchema,
} from './cloud-agent-next-schemas';

const MESSAGE_UUID = '12345678-1234-4234-9234-123456789abc';
const ATTACHMENT_ID = '87654321-4321-4321-8321-cba987654321';

describe('cloudAgentGetAttachmentUploadUrlSchema', () => {
  it('preserves the legacy 9-MIME contract when extension is absent', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'image/png',
      contentLength: 1024,
    });
    expect(result.success).toBe(true);
  });

  it('preserves the existing web-hook request shape (no extension field)', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.parse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'text/markdown',
      contentLength: 4096,
    });
    expect(result.contentType).toBe('text/markdown');
    expect(result.extension).toBeUndefined();
  });

  it('accepts a relaxed contentType when extension is provided', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'application/x-kilo-binary',
      contentLength: 4096,
      extension: 'kilo',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed contentType even when extension is provided', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'not a mime',
      contentLength: 4096,
      extension: 'kilo',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a contentType outside the legacy allow-list when extension is absent', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'application/x-kilo-binary',
      contentLength: 4096,
    });
    expect(result.success).toBe(false);
  });

  it('rejects deny-listed extensions on the upload input', () => {
    for (const extension of ['exe', 'dll', 'msi', 'com', 'scr', 'apk', 'ipa', 'dmg', 'pkg']) {
      const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
        contentType: 'application/octet-stream',
        contentLength: 4096,
        extension,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const extensionIssues = result.error.issues.filter(issue => issue.path[0] === 'extension');
        expect(extensionIssues[0]?.message).toContain(extension);
      }
    }
  });

  it('rejects extensions that exceed the 16-character shape or include non-alphanumerics', () => {
    expect(
      cloudAgentGetAttachmentUploadUrlSchema.safeParse({
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
        contentType: 'application/octet-stream',
        contentLength: 4096,
        extension: 'abcdefghijklmnopq',
      }).success
    ).toBe(false);
    expect(
      cloudAgentGetAttachmentUploadUrlSchema.safeParse({
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
        contentType: 'application/octet-stream',
        contentLength: 4096,
        extension: 'tar.gz',
      }).success
    ).toBe(false);
  });

  it('preserves the 5 MB positive contentLength cap even with an extension', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'application/octet-stream',
      contentLength: 5 * 1024 * 1024 + 1,
      extension: 'kilo',
    });
    expect(result.success).toBe(false);
  });
});

describe('cloudAgentRelaxedAttachmentFilenameSchema', () => {
  it('accepts any 1-16 char alphanumeric extension after the UUID prefix', () => {
    for (const filename of [
      `${ATTACHMENT_ID}.kilo`,
      `${ATTACHMENT_ID}.docx`,
      `${ATTACHMENT_ID}.tar`,
      `${ATTACHMENT_ID}.a`,
      `${ATTACHMENT_ID}.123`,
    ]) {
      expect(cloudAgentRelaxedAttachmentFilenameSchema.safeParse(filename).success).toBe(true);
    }
  });

  it('rejects filenames whose extension is in the deny-list', () => {
    for (const extension of ['exe', 'dll', 'msi', 'com', 'scr', 'apk', 'ipa', 'dmg', 'pkg']) {
      expect(
        cloudAgentRelaxedAttachmentFilenameSchema.safeParse(`${ATTACHMENT_ID}.${extension}`).success
      ).toBe(false);
    }
  });

  it('rejects filenames outside the UUID + 1-16 alphanumeric shape', () => {
    expect(cloudAgentRelaxedAttachmentFilenameSchema.safeParse('not-a-uuid.kilo').success).toBe(
      false
    );
    expect(cloudAgentRelaxedAttachmentFilenameSchema.safeParse(`${ATTACHMENT_ID}`).success).toBe(
      false
    );
    expect(
      cloudAgentRelaxedAttachmentFilenameSchema.safeParse(`${ATTACHMENT_ID}.abcdefghijklmnopq`)
        .success
    ).toBe(false);
  });
});

describe('cloudAgentGetAttachmentDownloadUrlSchema', () => {
  it('accepts a relaxed UUID.filename pair', () => {
    const result = cloudAgentGetAttachmentDownloadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      filename: `${ATTACHMENT_ID}.kilo`,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a deny-listed extension on the download input', () => {
    const result = cloudAgentGetAttachmentDownloadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      filename: `${ATTACHMENT_ID}.exe`,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unparseable filename', () => {
    const result = cloudAgentGetAttachmentDownloadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      filename: 'not-a-uuid.exe',
    });
    expect(result.success).toBe(false);
  });
});
