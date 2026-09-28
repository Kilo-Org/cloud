import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import {
  type RemoteMcpAuth,
  type RemoteMcpServerDraft,
  type StoredRemoteMcpServer,
} from '@/lib/chat/remote-mcp-store';

import { mcpServerFormError, type McpServerFormErrors } from './mcp-settings-state';

/**
 * The add/edit body of the remote MCP server sheet.
 *
 * Presentation only: it collects a name, a URL and an optional bearer token and
 * reports a draft to its caller. It never reads or writes the store, so adding
 * and editing go through the same component and the caller owns what happens to
 * the draft. The Save is gated on the same rules the store enforces, so a write
 * the store would refuse is refused before the person makes it.
 *
 * The fields are uncontrolled (see apps/mobile/AGENTS.md): the text lives in
 * refs and state is only what the UI derives from it — the gating and the error
 * each field shows.
 */

type RemoteMcpServerFormProps = {
  /** The server being edited. Absent when adding one. */
  readonly server?: StoredRemoteMcpServer;
  /** The draft the person asked to save. */
  readonly onSave: (draft: RemoteMcpServerDraft) => void;
  /** A save is in flight, so the Save shows it is working. */
  readonly saving?: boolean;
};

/** What the three fields hold, before they become a draft. */
type DraftFields = {
  readonly name: string;
  readonly url: string;
  readonly token: string;
};

/** The draft the three fields currently hold. `id` and `enabled` are the server's. */
function draftOf(
  server: StoredRemoteMcpServer | undefined,
  fields: DraftFields
): RemoteMcpServerDraft {
  const trimmedToken = fields.token.trim();
  const auth: RemoteMcpAuth =
    trimmedToken === '' ? { type: 'none' } : { type: 'bearer', token: trimmedToken };
  const draft: RemoteMcpServerDraft = {
    name: fields.name.trim(),
    url: fields.url.trim(),
    auth,
    enabled: server?.enabled ?? true,
  };
  return server === undefined ? draft : { ...draft, id: server.id };
}

export function RemoteMcpServerForm({
  server,
  onSave,
  saving,
}: Readonly<RemoteMcpServerFormProps>) {
  const { t } = useTranslation();
  const initialName = server?.name ?? '';
  const initialUrl = server?.url ?? '';
  const initialToken = server?.auth.type === 'bearer' ? (server.auth.token ?? '') : '';
  const name = useRef(initialName);
  const url = useRef(initialUrl);
  const token = useRef(initialToken);
  const [errors, setErrors] = useState<McpServerFormErrors | null>(() =>
    mcpServerFormError(draftOf(server, { name: initialName, url: initialUrl, token: initialToken }))
  );

  const refresh = useCallback(() => {
    setErrors(
      mcpServerFormError(
        draftOf(server, { name: name.current, url: url.current, token: token.current })
      )
    );
  }, [server]);

  const validateName = useCallback(
    (value: string): string | null => {
      const found = mcpServerFormError(
        draftOf(server, { name: value, url: url.current, token: token.current })
      );
      return found?.name === undefined ? null : t(found.name);
    },
    [server, t]
  );

  const validateUrl = useCallback(
    (value: string): string | null => {
      const found = mcpServerFormError(
        draftOf(server, { name: name.current, url: value, token: token.current })
      );
      return found?.url === undefined ? null : t(found.url);
    },
    [server, t]
  );

  const submit = useCallback(() => {
    const draft = draftOf(server, {
      name: name.current,
      url: url.current,
      token: token.current,
    });
    const found = mcpServerFormError(draft);
    setErrors(found);
    if (found === null) {
      onSave(draft);
    }
  }, [onSave, server]);

  return (
    <View className="gap-4">
      <FormField
        label={t('modelChat.mcp.fieldName')}
        defaultValue={initialName}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="next"
        onChangeText={value => {
          name.current = value;
          refresh();
        }}
        validate={validateName}
      />
      <FormField
        label={t('modelChat.mcp.fieldUrl')}
        defaultValue={initialUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="next"
        onChangeText={value => {
          url.current = value;
          refresh();
        }}
        validate={validateUrl}
      />
      <FormField
        label={t('modelChat.mcp.fieldToken')}
        defaultValue={initialToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        onChangeText={value => {
          token.current = value;
          refresh();
        }}
      />
      <Button onPress={submit} disabled={errors !== null} loading={saving}>
        <Text>{t('common.save')}</Text>
      </Button>
    </View>
  );
}
