import { ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { type RemoteMcpServerDraft, type StoredRemoteMcpServer } from '@/lib/chat/remote-mcp-store';

import { RemoteMcpServerForm } from './remote-mcp-server-form';

/**
 * The add-or-edit server form, as a sheet over the chat-tools sheet.
 *
 * It is the sheet's own nested view rather than a screen: the header closes it
 * without writing, and the form's Save is the only commit. Its own file keeps
 * the chat-tools sheet to the list it draws and the form to its fields.
 */

/** Which form the nested sheet is showing. */
export type McpServerFormTarget =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly server: StoredRemoteMcpServer };

type McpServerFormSheetProps = {
  readonly target: McpServerFormTarget;
  /** A write is in flight, so the form's Save shows it is working. */
  readonly saving: boolean;
  readonly onSubmit: (draft: RemoteMcpServerDraft) => void;
  readonly onClose: () => void;
};

export function McpServerFormSheet({
  target,
  saving,
  onSubmit,
  onClose,
}: Readonly<McpServerFormSheetProps>) {
  const { t } = useTranslation();
  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={t(
          target.kind === 'edit' ? 'modelChat.mcp.editServerTitle' : 'modelChat.mcp.addServerTitle'
        )}
        // The form's own Save is the only commit; the header closes the sheet
        // without writing, so it is a Close and not a second Done.
        doneLabel={t('common.close')}
        onDone={onClose}
        topInset="ios-page-sheet"
      />
      {/* The form's fields live in a scroll view with the keyboard insets
          adjusted, so a focused field is never under the keyboard and the Save
          stays reachable on a small screen. */}
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-6 pb-6 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <RemoteMcpServerForm
          server={target.kind === 'edit' ? target.server : undefined}
          onSave={onSubmit}
          saving={saving}
        />
      </ScrollView>
    </SessionPageSheet>
  );
}
