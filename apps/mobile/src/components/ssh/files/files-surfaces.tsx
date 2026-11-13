import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { FileNameDialog } from '@/components/ssh/files/file-name-dialog';
import { FilePreviewSheet, type FilePreview } from '@/components/ssh/files/file-preview-sheet';
import { SessionForwardsSheet } from '@/components/ssh/forwards/session-forwards-sheet';
import { MenuSheet, type MenuSheetOption } from '@/components/ui/menu-sheet';

export type FileNameTarget = { mode: 'rename'; entryName: string } | { mode: 'create' };

type FilesSurfacesProps = Readonly<{
  menuVisible: boolean;
  menuTitle: string | undefined;
  menuOptions: readonly MenuSheetOption[];
  onMenuClose: () => void;
  onMenuSelect: (index: number) => void;
  uploadVisible: boolean;
  onUploadClose: () => void;
  onPick: (source: 'files' | 'photos') => void;
  nameDialog: FileNameTarget | null;
  busy: boolean;
  onNameCancel: () => void;
  onNameSubmit: (name: string) => void;
  preview: FilePreview | null;
  onPreviewClose: () => void;
  onPreviewShare: () => void;
  onPreviewRetry: () => void;
  forwards: Readonly<{
    visible: boolean;
    hostId: string;
    sessionId: string;
    nativeSessionId: string | null;
  }> | null;
  onForwardsClose: () => void;
  dialog: ReactNode;
}>;

/** The menus, the name field and the preview the file list opens over itself. */
export function FilesSurfaces({
  menuVisible,
  menuTitle,
  menuOptions,
  onMenuClose,
  onMenuSelect,
  uploadVisible,
  onUploadClose,
  onPick,
  nameDialog,
  busy,
  onNameCancel,
  onNameSubmit,
  preview,
  onPreviewClose,
  onPreviewShare,
  onPreviewRetry,
  forwards,
  onForwardsClose,
  dialog,
}: FilesSurfacesProps) {
  const { t } = useTranslation();

  return (
    <>
      <MenuSheet
        visible={menuVisible}
        title={menuTitle}
        options={menuOptions}
        cancelLabel={t('common.cancel')}
        onClose={onMenuClose}
        onSelect={onMenuSelect}
      />

      <MenuSheet
        visible={uploadVisible}
        title={t('ssh.files.upload')}
        options={[{ label: t('ssh.files.fromFiles') }, { label: t('ssh.files.fromPhotos') }]}
        cancelLabel={t('common.cancel')}
        onClose={onUploadClose}
        onSelect={index => {
          onPick(index === 0 ? 'files' : 'photos');
        }}
      />

      {nameDialog === null ? null : (
        <FileNameDialog
          title={
            nameDialog.mode === 'rename'
              ? t('ssh.files.renameTitle', { name: nameDialog.entryName })
              : t('ssh.files.newFolderTitle')
          }
          initialValue={nameDialog.mode === 'rename' ? nameDialog.entryName : ''}
          confirmLabel={nameDialog.mode === 'rename' ? t('ssh.files.rename') : t('ssh.files.create')}
          busy={busy}
          onCancel={onNameCancel}
          onSubmit={onNameSubmit}
        />
      )}

      <FilePreviewSheet
        preview={preview}
        onClose={onPreviewClose}
        onShare={onPreviewShare}
        onRetry={onPreviewRetry}
      />

      {forwards === null ? null : (
        <SessionForwardsSheet
          visible={forwards.visible}
          hostId={forwards.hostId}
          sessionId={forwards.sessionId}
          nativeSessionId={forwards.nativeSessionId}
          onClose={onForwardsClose}
        />
      )}

      {dialog}
    </>
  );
}
