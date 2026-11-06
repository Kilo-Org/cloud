import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type AgentAttachment } from '@/lib/agent-attachments/use-agent-attachment-upload';

import { AttachmentPreviewStrip } from './attachment-preview-strip';

const FIXTURE_DIR_NAME = 'agent-attachment-fixture';
const FIXTURE_FILENAME = 'quarterly-report.pdf';
const FIXTURE_BYTES = 564;

/**
 * A one-page PDF with a valid cross-reference table, so the chip's document has
 * real bytes and a platform viewer can present it.
 */
const FIXTURE_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAw' +
  'IG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8' +
  'PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA1OTUgODQyXS9SZXNvdXJjZXM8' +
  'PC9Gb250PDwvRjEgNSAwIFI+Pj4+L0NvbnRlbnRzIDQgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwv' +
  'TGVuZ3RoIDU3Pj5zdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDc2MCBUZCAoQXR0YWNobWVudCBwcmV2' +
  'aWV3IGZpeHR1cmUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PC9UeXBlL0ZvbnQv' +
  'U3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAw' +
  'MDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTQgMDAwMDAgbiAKMDAw' +
  'MDAwMDEwNSAwMDAwMCBuIAowMDAwMDAwMjE3IDAwMDAwIG4gCjAwMDAwMDAzMjEgMDAwMDAgbiAK' +
  'dHJhaWxlcgo8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgozODQKJSVFT0YK';

/**
 * The composer's attachment strip with one uploaded document chip, reached
 * through the development fixture link for the attachment chip. Picking and
 * uploading a document by hand needs a system file picker and a working upload
 * service, so the design gate and a device check open that link instead. The
 * chip carries the attachment shape the upload hook produces, and its file is a
 * real cached PDF, so a preview tap presents a document rather than a missing
 * file.
 */
export function AttachmentChipFixture() {
  const insets = useSafeAreaInsets();

  const localUri = useMemo(() => {
    const directory = new Directory(Paths.cache, FIXTURE_DIR_NAME);
    return new File(directory, FIXTURE_FILENAME).uri;
  }, []);

  useEffect(() => {
    async function writeFixture() {
      const directory = new Directory(Paths.cache, FIXTURE_DIR_NAME);
      directory.create({ idempotent: true, intermediates: true });
      const file = new File(directory, FIXTURE_FILENAME);
      if (file.exists) {
        return;
      }
      await file.write(FIXTURE_PDF_BASE64, { encoding: 'base64' });
    }
    void writeFixture();
  }, []);

  const attachments = useMemo<AgentAttachment[]>(
    () => [
      {
        id: 'attachment-chip-fixture',
        filename: FIXTURE_FILENAME,
        kind: 'document',
        extension: 'pdf',
        mimeType: 'application/pdf',
        size: FIXTURE_BYTES,
        localUri,
        localFileOwned: true,
        status: 'uploaded',
        progress: 1,
      },
    ],
    [localUri]
  );

  return (
    <View className="flex-1 justify-end bg-background pb-2">
      <AttachmentPreviewStrip
        attachments={attachments}
        onRemove={() => undefined}
        onRetry={() => undefined}
        onMove={() => undefined}
        onReorder={() => undefined}
      />
      <View style={{ height: insets.bottom }} />
    </View>
  );
}
