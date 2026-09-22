/* eslint-disable @typescript-eslint/promise-function-async, require-await -- This module wraps Alert.alert and select-style pickers in Promise-returning helpers, so require-await and promise-function-async apply; prefer-await-to-then still applies inside the body. */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { type ActionSheetProps } from '@expo/react-native-action-sheet';
import { Alert, Linking } from 'react-native';
import * as Sentry from '@sentry/react-native';

import { i18n } from '@/i18n';
import { AGENT_ATTACHMENT_EXTENSION_REGEX } from '@/lib/agent-attachments/constants';
import { mimeForExtension, normalizeAttachmentExtension } from '@/lib/agent-attachments/validate';
import { IMAGE_PICKER_OPTIONS, launchImagePicker } from '@/lib/agent-attachments/image-picker';
import {
  type AttachmentSurface,
  writePickerLaunchContext,
} from '@/lib/agent-attachments/picker-launch-context';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { registerTempFile } from '@/lib/temp-file-registry';

function showPermissionSettingsAlert({ message, title }: { message: string; title: string }) {
  Alert.alert(title, message, [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    { text: i18n.t('common.openSettings'), onPress: () => void Linking.openSettings() },
  ]);
}

export function normalizeImageAsset(asset: {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}): AgentAttachmentCandidate {
  // Keep the picker's filename when it is non-empty after trimming.
  const fileName = asset.fileName?.trim();
  if (fileName) {
    return {
      name: fileName,
      uri: asset.uri,
      mimeType: asset.mimeType ?? undefined,
      size: asset.fileSize ?? undefined,
    };
  }

  // The image picker can omit the filename — camera HEIC assets report
  // `application/octet-stream` with no name. Synthesize `image.<ext>` from
  // the URI extension, then the MIME subtype, then fall back to `image.png`.
  // The upload hook re-measures size via `getInfoAsync`; `size` here is
  // informational.
  const uriExtension = asset.uri.split('.').pop()?.toLowerCase();
  const mimeSubtype = asset.mimeType?.split('/')[1]?.toLowerCase();
  const extension =
    (uriExtension && AGENT_ATTACHMENT_EXTENSION_REGEX.test(uriExtension) ? uriExtension : null) ??
    (mimeSubtype && AGENT_ATTACHMENT_EXTENSION_REGEX.test(mimeSubtype) ? mimeSubtype : null) ??
    'png';
  return {
    name: `image.${extension}`,
    uri: asset.uri,
    mimeType: asset.mimeType ?? undefined,
    size: asset.fileSize ?? undefined,
  };
}

function normalizeDocumentAsset(asset: {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}): AgentAttachmentCandidate {
  // The picker MIME is intentionally NOT consulted. The cloud-agent
  // storage layer rejects anything outside the canonical extension
  // table, and iOS pickers report `application/octet-stream` for any
  // extension the platform doesn't ship a UTI for. Resolving MIME from
  // the extension makes the picker → upload hook contract exact.
  const extension = normalizeAttachmentExtension(asset.name);
  return {
    name: asset.name,
    uri: asset.uri,
    // The candidate shape carries MIME for kilochat-picker parity, but
    // the agent-attachments classifier ignores it and re-derives from
    // the extension. No closed-union cast — the extension is whatever
    // survives `normalizeAttachmentExtension`, including the `bin`
    // fallback.
    mimeType: mimeForExtension(extension),
    size: asset.size,
  };
}

async function pickAgentCameraImage(): Promise<AgentAttachmentCandidate[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    showPermissionSettingsAlert({
      title: i18n.t('common.cameraAccessDisabled'),
      message: i18n.t('chat.attachmentPicker.cameraAccessMessage'),
    });
    return [];
  }
  const assets = await launchImagePicker(ImagePicker.launchCameraAsync(IMAGE_PICKER_OPTIONS));
  const candidates = assets.map(asset => normalizeImageAsset(asset));
  for (const candidate of candidates) {
    registerTempFile(candidate.uri);
  }
  return candidates;
}

async function pickAgentLibraryImages(
  allowsMultipleSelection: boolean
): Promise<AgentAttachmentCandidate[]> {
  const assets = await launchImagePicker(
    ImagePicker.launchImageLibraryAsync({
      ...IMAGE_PICKER_OPTIONS,
      allowsMultipleSelection,
    })
  );
  const candidates = assets.map(asset => normalizeImageAsset(asset));
  for (const candidate of candidates) {
    registerTempFile(candidate.uri);
  }
  return candidates;
}

async function pickAgentDocuments(): Promise<AgentAttachmentCandidate[]> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
    type: '*/*',
  });
  if (result.canceled) {
    return [];
  }
  const candidates = result.assets.map(normalizeDocumentAsset);
  for (const candidate of candidates) {
    registerTempFile(candidate.uri);
  }
  return candidates;
}

type AttachmentSource = 'camera' | 'library' | 'files';

function attachmentSourceLabel(source: AttachmentSource): string {
  if (source === 'camera') {
    return i18n.t('agentChat.attachmentPicker.camera');
  }
  if (source === 'library') {
    return i18n.t('agentChat.attachmentPicker.photoLibrary');
  }
  return i18n.t('agentChat.attachmentPicker.files');
}

/** Sheet option labels for `sources`, with Cancel always appended last. */
function buildAttachmentSourceOptions(sources: readonly AttachmentSource[]): string[] {
  return [...sources.map(source => attachmentSourceLabel(source)), i18n.t('common.cancel')];
}

async function pickFromSource(
  source: AttachmentSource,
  libraryMultipleSelection: boolean
): Promise<AgentAttachmentCandidate[]> {
  if (source === 'camera') {
    return pickAgentCameraImage();
  }
  if (source === 'library') {
    return pickAgentLibraryImages(libraryMultipleSelection);
  }
  return pickAgentDocuments();
}

type AttachmentPickerContext = {
  userId: string | undefined;
  surface: AttachmentSurface;
  sessionId: string | null;
};

type AttachmentSourceSheet = {
  sources: readonly AttachmentSource[];
  libraryMultipleSelection: boolean;
};

/**
 * Show the source sheet and resolve the picked candidates. `sources` drives
 * both the option list (Cancel is appended last) and the button-index mapping:
 * the cancel button, or any index with no source, resolves with no candidates.
 * Identical for every entry point apart from its sources and the library's
 * multi-select flag.
 */
function showAttachmentSourceSheet(
  showActionSheetWithOptions: ActionSheetProps['showActionSheetWithOptions'],
  context: AttachmentPickerContext,
  sheet: AttachmentSourceSheet
): Promise<AgentAttachmentCandidate[]> {
  const { sources, libraryMultipleSelection } = sheet;
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: AgentAttachmentCandidate[]) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const handle = async (source: AttachmentSource) => {
      // Record the launching composer + account before the camera/library
      // launch so the recovery hook can match a pending result after an
      // Activity recreation. NOT before the Files branch, which uses
      // `startActivityForResult` and is unaffected by that bug. Only record
      // the launch when a real user id is present; an empty id would store a
      // context the recovery hook can never match.
      if ((source === 'camera' || source === 'library') && context.userId) {
        try {
          await writePickerLaunchContext({
            userId: context.userId,
            surface: context.surface,
            sessionId: context.sessionId,
            launchedAt: Date.now(),
          });
        } catch (error) {
          // A store write failure must not block the picker launch; the
          // recovery hook simply finds no context and nothing is attached.
          Sentry.captureException(error, {
            tags: {
              'error.subsystem': 'agent-attachments',
              'error.operation': 'write-picker-launch-context',
            },
            extra: { source, surface: context.surface, hasSession: context.sessionId !== null },
          });
        }
      }
      try {
        settle(await pickFromSource(source, libraryMultipleSelection));
      } catch (error) {
        // A rejected `requestCameraPermissionsAsync` (or any other failure
        // inside the source helper, e.g. a synchronous throw while building
        // the native launch promise) must still settle the public helper.
        // `handle` runs detached, so an uncaught rejection would hang the
        // caller's `await` forever; no candidates means "nothing picked", so
        // the caller stays where it is and can tap again.
        Sentry.captureException(error, {
          tags: {
            'error.subsystem': 'agent-attachments',
            'error.operation': 'pick-attachment-source',
          },
          extra: { source, surface: context.surface, hasSession: context.sessionId !== null },
        });
        settle([]);
      }
    };
    const options = buildAttachmentSourceOptions(sources);
    showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: options.length - 1,
      },
      index => {
        // The sheet's button index is optional by its own types; the cancel
        // button is the label appended after the last source.
        const source = index === undefined ? undefined : sources[index];
        if (source === undefined) {
          settle([]);
          return;
        }
        void handle(source);
      }
    );
  });
}

/**
 * Composer entry point: Camera, Photo Library, and Files, with a multi-select
 * library. Resolves with no candidates on cancel, denied permission, or a
 * failed launch.
 */
export function pickAgentAttachments(
  showActionSheetWithOptions: ActionSheetProps['showActionSheetWithOptions'],
  context: AttachmentPickerContext
): Promise<AgentAttachmentCandidate[]> {
  return showAttachmentSourceSheet(showActionSheetWithOptions, context, {
    sources: ['camera', 'library', 'files'],
    libraryMultipleSelection: true,
  });
}

/**
 * Picture entry point: Camera and the single-select Photo Library only, so one
 * tap on a screenshot returns it. Resolves with no candidates on cancel,
 * denied permission, or a failed launch — the caller stays where it is.
 */
export function pickAgentPicture(
  showActionSheetWithOptions: ActionSheetProps['showActionSheetWithOptions'],
  context: AttachmentPickerContext
): Promise<AgentAttachmentCandidate[]> {
  return showAttachmentSourceSheet(showActionSheetWithOptions, context, {
    sources: ['camera', 'library'],
    libraryMultipleSelection: false,
  });
}
