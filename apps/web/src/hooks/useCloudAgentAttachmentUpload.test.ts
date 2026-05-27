import {
  buildCloudAgentAttachments,
  classifyCloudAgentAttachmentType,
  preprocessCloudAgentAttachmentFile,
  selectFilesWithinAttachmentLimit,
  shouldCancelCloudAgentAttachmentUpload,
  shouldContinueCloudAgentAttachmentUpload,
  type CloudAgentAttachmentFile,
} from './useCloudAgentAttachmentUpload';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
  CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES,
} from '@/lib/cloud-agent/constants';

function createFile(name: string, type: string, size = 32) {
  return new File([new Uint8Array(size)], name, { type });
}

describe('cloud agent attachment classification', () => {
  it('normalizes Markdown filenames only for browser text-compatible MIME values', () => {
    expect(classifyCloudAgentAttachmentType(createFile('notes.md', ''))).toBe('text/markdown');
    expect(classifyCloudAgentAttachmentType(createFile('NOTES.MD', 'text/plain'))).toBe(
      'text/markdown'
    );
    expect(classifyCloudAgentAttachmentType(createFile('notes.md', 'text/markdown'))).toBe(
      'text/markdown'
    );
    expect(
      classifyCloudAgentAttachmentType(createFile('spoofed.md', 'application/pdf'))
    ).toBeNull();
    expect(
      classifyCloudAgentAttachmentType(createFile('spoofed.md', 'application/octet-stream'))
    ).toBeNull();
  });

  it('accepts PDF, text, and CSV documents without accepting unsupported files', () => {
    expect(classifyCloudAgentAttachmentType(createFile('report.pdf', 'application/pdf'))).toBe(
      'application/pdf'
    );
    expect(classifyCloudAgentAttachmentType(createFile('report.pdf', ''))).toBe('application/pdf');
    expect(classifyCloudAgentAttachmentType(createFile('context.txt', 'text/plain'))).toBe(
      'text/plain'
    );
    expect(classifyCloudAgentAttachmentType(createFile('context.txt', ''))).toBe('text/plain');
    expect(classifyCloudAgentAttachmentType(createFile('records.csv', 'text/csv'))).toBe(
      'text/csv'
    );
    expect(classifyCloudAgentAttachmentType(createFile('records.csv', ''))).toBe('text/csv');
    expect(classifyCloudAgentAttachmentType(createFile('records.csv', 'text/plain'))).toBeNull();
    expect(classifyCloudAgentAttachmentType(createFile('records.txt', 'text/csv'))).toBeNull();
    expect(
      classifyCloudAgentAttachmentType(createFile('archive.zip', 'application/zip'))
    ).toBeNull();
  });
});

describe('cloud agent attachment preprocessing', () => {
  it('uses existing image preprocessing semantics for images', async () => {
    const file = createFile('diagram.png', 'image/png');
    const resized = createFile('diagram.png', 'image/png', 16);
    const processImage = jest.fn().mockResolvedValue(resized);

    await expect(preprocessCloudAgentAttachmentFile(file, processImage)).resolves.toEqual({
      file: resized,
      contentType: 'image/png',
      kind: 'image',
    });
    expect(processImage).toHaveBeenCalledWith(file, {
      allowedTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxOriginalFileSizeBytes: CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES,
      maxFileSizeBytes: CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES,
      resizeImages: { maxDimensionPx: 1536 },
    });
  });

  it('does not transform documents and enforces the final upload size limit', async () => {
    const file = createFile('notes.md', 'text/plain');
    const processImage = jest.fn();

    await expect(preprocessCloudAgentAttachmentFile(file, processImage)).resolves.toEqual({
      file,
      contentType: 'text/markdown',
      kind: 'document',
    });
    expect(processImage).not.toHaveBeenCalled();

    const oversized = createFile(
      'report.pdf',
      'application/pdf',
      CLOUD_AGENT_ATTACHMENT_MAX_SIZE_BYTES + 1
    );
    await expect(preprocessCloudAgentAttachmentFile(oversized, processImage)).rejects.toThrow(
      'Final file too large'
    );
  });
});

describe('cloud agent attachment upload continuation', () => {
  it('stops upload continuation for cancelled attachments', () => {
    expect(shouldContinueCloudAgentAttachmentUpload(true, true)).toBe(false);
  });

  it('stops upload continuation after unmount', () => {
    expect(shouldContinueCloudAgentAttachmentUpload(false, false)).toBe(false);
  });

  it('allows upload continuation while mounted and not cancelled', () => {
    expect(shouldContinueCloudAgentAttachmentUpload(true, false)).toBe(true);
  });
});

describe('cloud agent attachment cancellation markers', () => {
  it('requires cancellation markers for each in-flight state', () => {
    expect(shouldCancelCloudAgentAttachmentUpload('processing')).toBe(true);
    expect(shouldCancelCloudAgentAttachmentUpload('pending')).toBe(true);
    expect(shouldCancelCloudAgentAttachmentUpload('uploading')).toBe(true);
  });

  it('does not require cancellation markers for terminal states', () => {
    expect(shouldCancelCloudAgentAttachmentUpload('error')).toBe(false);
    expect(shouldCancelCloudAgentAttachmentUpload('complete')).toBe(false);
  });
});

describe('cloud agent attachment descriptors and limits', () => {
  it('builds canonical attachments from completed uploads in display order', () => {
    const attachments: CloudAgentAttachmentFile[] = [
      {
        id: 'one',
        file: createFile('notes.md', 'text/markdown'),
        contentType: 'text/markdown',
        kind: 'document',
        status: 'complete',
        progress: 100,
        r2Key: 'user/cloud-agent/message/one.md',
      },
      {
        id: 'two',
        file: createFile('still-pending.pdf', 'application/pdf'),
        contentType: 'application/pdf',
        kind: 'document',
        status: 'uploading',
        progress: 25,
      },
      {
        id: 'three',
        file: createFile('image.png', 'image/png'),
        contentType: 'image/png',
        kind: 'image',
        status: 'complete',
        progress: 100,
        r2Key: 'user/cloud-agent/message/three.png',
      },
    ];

    expect(buildCloudAgentAttachments('message-uuid', attachments)).toEqual({
      path: 'message-uuid',
      files: ['one.md', 'three.png'],
    });
  });

  it('keeps no more than five files per prompt', () => {
    const selected = selectFilesWithinAttachmentLimit(
      [createFile('four.txt', 'text/plain'), createFile('five.pdf', 'application/pdf')],
      CLOUD_AGENT_ATTACHMENT_MAX_COUNT - 1
    );

    expect(selected.acceptedFiles).toHaveLength(1);
    expect(selected.rejectedCount).toBe(1);
    expect(selectFilesWithinAttachmentLimit([createFile('six.txt', 'text/plain')], 5)).toEqual({
      acceptedFiles: [],
      rejectedCount: 1,
    });
  });
});
