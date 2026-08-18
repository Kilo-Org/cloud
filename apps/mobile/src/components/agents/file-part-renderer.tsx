/* eslint-disable max-lines -- cohesive renderer: image viewer, preview modal, and file:///data:/http(s) resolve+share paths share one component */
import { useActionSheet } from '@expo/react-native-action-sheet';
import { type FilePart } from '@kilocode/cloud-agent-sdk';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { ImageViewerModal } from '@/components/image-viewer-modal';
import { SheetHeader } from '@/components/sheet-header';
import { AlertCircle, File as FileIcon } from '@/components/ui/icons';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  downloadRemoteFile,
  getSafeCacheFilename,
  getShareRemoteFileReason,
  shareLocalFile,
  shareRemoteFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';

import { ChatMarkdownText } from './chat-markdown-text';
import { isUsableFilePartUrl, useFilePartCache } from './file-part-cache';
import { getFilePartAccessibilityLabel, getFilePartKind } from './file-part-preview';
import { stripDataUrlBase64Prefix } from './tool-card-image-cache';

const CACHE_DIR_NAME = 'session-file-parts';

function cacheFilenameForPart(part: Pick<FilePart, 'id' | 'mime' | 'filename'>): string {
  return getSafeCacheFilename({ id: part.id, filename: part.filename ?? 'file' });
}

/** Write a base64 `data:` payload to the cache and return the file. */
function writeDataUrlToCache(url: string, part: Pick<FilePart, 'id' | 'mime' | 'filename'>): File {
  const payload = stripDataUrlBase64Prefix(url, part.mime);
  if (payload === undefined) {
    throw new Error('decode-failed');
  }
  const directory = new Directory(Paths.cache, CACHE_DIR_NAME);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, cacheFilenameForPart(part));
  file.write(payload, { encoding: 'base64' });
  return file;
}

/** Resolve the file text for a preview, keeping the file for a later share. */
async function resolveFileText(url: string, part: Pick<FilePart, 'id' | 'mime' | 'filename'>) {
  if (url.startsWith('file://')) {
    return new File(url).text();
  }

  if (url.startsWith('data:')) {
    const file = writeDataUrlToCache(url, part);
    return file.text();
  }

  const local = await downloadRemoteFile({
    url,
    cacheDirectoryName: CACHE_DIR_NAME,
    cacheFilename: cacheFilenameForPart(part),
  });
  try {
    return await new File(local.uri).text();
  } catch (error) {
    local.delete();
    throw error;
  }
}

/** Share a FilePart, materializing a `data:` URL or downloading an `http(s)` URL. */
async function shareFilePart(url: string, part: FilePart): Promise<void> {
  if (url.startsWith('file://')) {
    await shareLocalFile(url, { mimeType: part.mime });
    return;
  }
  if (url.startsWith('data:')) {
    const file = writeDataUrlToCache(url, part);
    await shareLocalFile(file.uri, { mimeType: part.mime });
    return;
  }
  await shareRemoteFile({
    url,
    cacheDirectoryName: CACHE_DIR_NAME,
    cacheKey: part.id,
    filename: part.filename ?? 'file',
  });
}

type FilePartRendererProps = {
  part: FilePart;
};

type PreviewMode = 'markdown' | 'text';

/** Prefer the captured cache URL, falling back to the part's own URL. The
 *  cached URL is produced by our cache and is always trusted. */
function resolveUsableUrl(cachedUrl: string | undefined, partUrl: string): string | undefined {
  if (cachedUrl) {
    return cachedUrl;
  }
  if (isUsableFilePartUrl(partUrl)) {
    return partUrl;
  }
  return undefined;
}

export function FilePartRenderer({ part }: Readonly<FilePartRendererProps>) {
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();

  const cached = useFilePartCache(part.id);
  const url = resolveUsableUrl(cached?.url, part.url);
  const kind = getFilePartKind({ mime: part.mime, filename: part.filename });

  const [viewerVisible, setViewerVisible] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [preview, setPreview] = useState<PreviewMode | null>(null);
  const [sharing, setSharing] = useState(false);

  async function handleShare() {
    if (!url) {
      return;
    }
    setSharing(true);
    try {
      await shareFilePart(url, part);
    } catch (error: unknown) {
      const reason = getShareRemoteFileReason(error);
      if (reason === 'sharing-unavailable') {
        toast.error('File sharing is not available on this device.');
      } else if (error instanceof ShareRemoteFileError) {
        toast.error('Failed to share file. Please try again.');
      } else {
        toast.error('Share failed');
      }
    } finally {
      setSharing(false);
    }
  }

  function handleChipTap() {
    if (!url) {
      toast.error('Preview unavailable');
      return;
    }
    if (kind === 'markdown') {
      setPreview('markdown');
      return;
    }
    showActionSheetWithOptions(
      {
        options: ['Open as text', 'Open in external app', 'Cancel'],
        cancelButtonIndex: 2,
      },
      index => {
        if (index === undefined || index === 2) {
          return;
        }
        if (index === 0) {
          setPreview('text');
        } else if (index === 1) {
          void handleShare();
        }
      }
    );
  }

  if (kind === 'image') {
    if (url) {
      if (imageFailed) {
        return (
          <Pressable
            onPress={() => {
              setImageFailed(false);
            }}
            className="my-1 flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900"
            accessibilityRole="button"
            accessibilityLabel="Image unavailable, retry loading"
          >
            <AlertCircle size={14} color={colors.mutedForeground} />
            <Text className="text-xs text-muted-foreground">Image unavailable</Text>
          </Pressable>
        );
      }
      return (
        <>
          <Pressable
            onPress={() => {
              setViewerVisible(true);
            }}
            className="my-1 overflow-hidden rounded-lg active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel={getFilePartAccessibilityLabel('image', part.filename)}
          >
            <Image
              source={{ uri: url }}
              className="aspect-video w-full"
              contentFit="contain"
              accessible
              accessibilityRole="image"
              accessibilityLabel={part.filename ? `Image output, ${part.filename}` : 'Image output'}
              onError={() => {
                setImageFailed(true);
              }}
            />
            {part.filename ? (
              <Text className="mt-1 text-xs text-muted-foreground">{part.filename}</Text>
            ) : null}
          </Pressable>
          {viewerVisible && (
            <ImageViewerModal
              visible={viewerVisible}
              uri={url}
              filename={part.filename ?? 'File'}
              onClose={() => {
                setViewerVisible(false);
              }}
            />
          )}
        </>
      );
    }
    return (
      <View className="my-1 flex-row items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
        <AlertCircle size={14} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">Image unavailable</Text>
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={handleChipTap}
        disabled={sharing}
        accessibilityState={{ busy: sharing }}
        accessibilityRole="button"
        accessibilityLabel={getFilePartAccessibilityLabel(kind, part.filename)}
        className="my-1 flex-row items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 active:opacity-80 dark:bg-neutral-900"
      >
        {sharing ? <ActivityIndicator /> : <FileIcon size={14} color={colors.mutedForeground} />}
        <Text className="text-sm text-muted-foreground" numberOfLines={1}>
          {part.filename ?? 'File'}
        </Text>
      </Pressable>
      {preview && url ? (
        <FilePreviewModal
          mode={preview}
          url={url}
          part={part}
          onClose={() => {
            setPreview(null);
          }}
        />
      ) : null}
    </>
  );
}

type FilePreviewModalProps = {
  mode: PreviewMode;
  url: string;
  part: FilePart;
  onClose: () => void;
};

function FilePreviewModal({ mode, url, part, onClose }: Readonly<FilePreviewModalProps>) {
  const { id, mime, filename } = part;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [text, setText] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    async function load() {
      try {
        const resolved = await resolveFileText(url, { id, mime, filename });
        if (cancelled) {
          return;
        }
        setText(resolved);
        setStatus('ready');
      } catch {
        if (cancelled) {
          return;
        }
        setStatus('error');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [url, id, mime, filename, attempt]);

  function renderBody() {
    if (status === 'loading') {
      return <ActivityIndicator />;
    }
    if (status === 'error') {
      return (
        <View className="gap-3">
          <Text className="text-sm text-muted-foreground">Could not load this file.</Text>
          <Pressable
            onPress={() => {
              setAttempt(prev => prev + 1);
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading file"
            className="rounded-md border border-border px-4 py-2 active:opacity-70"
          >
            <Text className="text-center text-sm font-medium text-foreground">Retry</Text>
          </Pressable>
        </View>
      );
    }
    if (text === '') {
      return <Text className="text-xs text-muted-foreground">This file is empty.</Text>;
    }
    if (mode === 'markdown') {
      return <ChatMarkdownText value={text} />;
    }
    return <Text className="text-sm text-foreground">{text}</Text>;
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View className="flex-1 bg-background">
        <SheetHeader title={part.filename ?? 'File'} onDone={onClose} doneLabel="Done" />
        <ScrollView contentContainerClassName="px-6 pb-6 pt-2">{renderBody()}</ScrollView>
      </View>
    </Modal>
  );
}
