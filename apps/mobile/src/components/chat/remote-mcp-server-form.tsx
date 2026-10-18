import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
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
 * Presentation only: it collects a name, a URL and how the server signs in —
 * nothing, a bearer token, or OAuth in the browser after the save — and
 * reports a draft to its caller. It never reads or writes the store, so adding
 * and editing go through the same component and the caller owns what happens to
 * the draft. The Save is gated on the same rules the store enforces, so a write
 * the store would refuse is refused before the person makes it.
 *
 * The fields are uncontrolled (see apps/mobile/AGENTS.md): the text lives in
 * refs and state is only what the UI derives from it — the gating, the error
 * each field shows, and the chosen sign-in method.
 */

type RemoteMcpServerFormProps = {
  /** The server being edited. Absent when adding one. */
  readonly server?: StoredRemoteMcpServer;
  /** The draft the person asked to save. */
  readonly onSave: (draft: RemoteMcpServerDraft) => void;
  /** A save is in flight, so the Save shows it is working. */
  readonly saving?: boolean;
};

type AuthMethod = RemoteMcpAuth['type'];

/** What the fields hold, before they become a draft. */
type DraftFields = {
  readonly name: string;
  readonly url: string;
  readonly method: AuthMethod;
  readonly token: string;
};

function authOf(method: AuthMethod, token: string): RemoteMcpAuth {
  if (method === 'bearer') {
    const trimmed = token.trim();
    return trimmed === '' ? { type: 'bearer' } : { type: 'bearer', token: trimmed };
  }
  return { type: method };
}

/** The draft the fields currently hold. `id` and `enabled` are the server's. */
function draftOf(
  server: StoredRemoteMcpServer | undefined,
  fields: DraftFields
): RemoteMcpServerDraft {
  const draft: RemoteMcpServerDraft = {
    name: fields.name.trim(),
    url: fields.url.trim(),
    auth: authOf(fields.method, fields.token),
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
  const [method, setMethod] = useState<AuthMethod>(server?.auth.type ?? 'none');
  const fieldsWith = useCallback(
    (changed: Partial<DraftFields>): DraftFields => ({
      name: name.current,
      url: url.current,
      method,
      token: token.current,
      ...changed,
    }),
    [method]
  );
  const [errors, setErrors] = useState<McpServerFormErrors | null>(() =>
    mcpServerFormError(
      draftOf(server, { name: initialName, url: initialUrl, method, token: initialToken })
    )
  );

  const refresh = useCallback(
    (changed: Partial<DraftFields> = {}) => {
      setErrors(mcpServerFormError(draftOf(server, fieldsWith(changed))));
    },
    [fieldsWith, server]
  );

  const validateName = useCallback(
    (value: string): string | null => {
      const found = mcpServerFormError(draftOf(server, fieldsWith({ name: value })));
      return found?.name === undefined ? null : t(found.name);
    },
    [fieldsWith, server, t]
  );

  const validateUrl = useCallback(
    (value: string): string | null => {
      const found = mcpServerFormError(draftOf(server, fieldsWith({ url: value })));
      return found?.url === undefined ? null : t(found.url);
    },
    [fieldsWith, server, t]
  );

  const validateToken = useCallback(
    (value: string): string | null => {
      const found = mcpServerFormError(draftOf(server, fieldsWith({ token: value })));
      return found?.token === undefined ? null : t(found.token);
    },
    [fieldsWith, server, t]
  );

  const submit = useCallback(() => {
    const draft = draftOf(server, fieldsWith({}));
    const found = mcpServerFormError(draft);
    setErrors(found);
    if (found === null) {
      onSave(draft);
    }
  }, [fieldsWith, onSave, server]);

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
      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">
          {t('modelChat.mcpOAuth.authMethod')}
        </Text>
        <SegmentedControl
          options={[
            { value: 'none', label: t('modelChat.mcpOAuth.authNone') },
            { value: 'bearer', label: t('modelChat.mcpOAuth.authBearer') },
            { value: 'oauth', label: t('modelChat.mcpOAuth.authOAuth') },
          ]}
          value={method}
          onChange={next => {
            setMethod(next);
            refresh({ method: next });
          }}
          accessibilityLabel={t('modelChat.mcpOAuth.authMethod')}
        />
      </View>
      {method === 'bearer' ? (
        <FormField
          label={t('modelChat.mcpOAuth.fieldToken')}
          defaultValue={initialToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          onChangeText={value => {
            token.current = value;
            refresh();
          }}
          validate={validateToken}
        />
      ) : null}
      {method === 'oauth' ? (
        <Text variant="muted" className="text-xs">
          {t('modelChat.mcpOAuth.oauthHint')}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={errors !== null} loading={saving}>
        <Text>{t('common.save')}</Text>
      </Button>
    </View>
  );
}
