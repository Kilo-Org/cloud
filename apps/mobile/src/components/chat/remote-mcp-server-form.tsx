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
import { normalizeRemoteMcpUrl } from '@/lib/chat/remote-mcp-url';

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
  /**
   * Whether the fields differ from what the form opened with. The sheet asks it
   * before closing, so a Close or Android Back does not drop a typed server.
   */
  readonly onDirtyChange?: (dirty: boolean) => void;
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

/**
 * The endpoint a URL text names, normalized the way the store normalizes it, or
 * null when the text names none. The form compares these to decide whether a
 * bearer value belongs to the endpoint the URL now names.
 */
function endpointOf(url: string): string | null {
  try {
    return normalizeRemoteMcpUrl(url);
  } catch {
    return null;
  }
}

/**
 * Who owns the token field's text. The field is uncontrolled, so this is the one
 * place its value lives:
 *
 * - `saved`: the field shows the token the server was saved with.
 * - `typed`: the person typed `text`, for the endpoint the URL named then (null
 *   while it named none).
 * - `retargeted`: the field was cleared because the URL left the endpoint that
 *   value belonged to, and it says why under an empty field.
 */
type TokenField =
  | { readonly kind: 'saved' }
  | { readonly kind: 'typed'; readonly text: string; readonly endpoint: string | null }
  | { readonly kind: 'retargeted' };

/** The text the field holds, which is both its default and what a save sends. */
function tokenText(field: TokenField, savedToken: string): string {
  switch (field.kind) {
    case 'saved':
      return savedToken;
    case 'typed':
      return field.text;
    case 'retargeted':
      return '';
  }
}

/**
 * What the token field becomes when the URL names `endpoint`, and whether it has
 * to be mounted again for the new text to show.
 *
 * A value belongs to the endpoint the URL named when it was typed; the saved
 * value belongs to the saved endpoint. A URL that names another endpoint clears
 * the field rather than carrying a value to a server it was not entered for, and
 * the saved endpoint brings the saved value back — respelling the saved URL is
 * not an edit. A value typed while the URL named nothing belongs to the endpoint
 * the person then names, so that one case keeps it.
 */
function retargetTokenField(
  field: TokenField,
  savedEndpoint: string | null,
  endpoint: string | null
): { readonly field: TokenField; readonly remount: boolean } {
  if (field.kind === 'typed') {
    if (field.endpoint === null) {
      return { field: { kind: 'typed', text: field.text, endpoint }, remount: false };
    }
    if (field.endpoint === endpoint) {
      return { field, remount: false };
    }
    return { field: { kind: 'retargeted' }, remount: true };
  }
  if (field.kind === 'retargeted') {
    return endpoint !== null && endpoint === savedEndpoint
      ? { field: { kind: 'saved' }, remount: true }
      : { field, remount: false };
  }
  if (endpoint === savedEndpoint) {
    return { field, remount: false };
  }
  return { field: { kind: 'retargeted' }, remount: true };
}

export function RemoteMcpServerForm({
  server,
  onSave,
  saving,
  onDirtyChange,
}: Readonly<RemoteMcpServerFormProps>) {
  const { t } = useTranslation();
  const initialName = server?.name ?? '';
  const initialUrl = server?.url ?? '';
  const initialToken = server?.auth.type === 'bearer' ? (server.auth.token ?? '') : '';
  const initialMethod = server?.auth.type ?? 'none';
  /** The endpoint the saved URL names, which is what a saved token belongs to. */
  const savedEndpoint = endpointOf(initialUrl);
  const name = useRef(initialName);
  const url = useRef(initialUrl);
  /**
   * The token field's text and who owns it. Held in a ref: the field is
   * uncontrolled and the text stays out of React state. `retargeted` is the only
   * member the screen draws, as the reason the field is empty.
   */
  const tokenField = useRef<TokenField>({ kind: 'saved' });
  /**
   * Bumped only when the field has to show different text than it does — a
   * retarget, or the saved value coming back. A keystroke never bumps it: the
   * field already shows what was typed, and remounting it would drop the caret.
   */
  const [tokenFieldKey, setTokenFieldKey] = useState(0);
  const [method, setMethod] = useState<AuthMethod>(initialMethod);
  const fieldsWith = useCallback(
    (changed: Partial<DraftFields>): DraftFields => ({
      name: name.current,
      url: url.current,
      method,
      token: tokenText(tokenField.current, initialToken),
      ...changed,
    }),
    [method, initialToken]
  );
  const [errors, setErrors] = useState<McpServerFormErrors | null>(() =>
    mcpServerFormError(
      draftOf(server, { name: initialName, url: initialUrl, method, token: initialToken })
    )
  );

  const refresh = useCallback(
    (changed: Partial<DraftFields> = {}) => {
      const next = fieldsWith(changed);
      setErrors(mcpServerFormError(draftOf(server, next)));
      // Compare what the saved draft keeps: it trims the name, URL and bearer
      // token, so whitespace alone is not an edit worth confirming.
      onDirtyChange?.(
        next.name.trim() !== initialName.trim() ||
          next.url.trim() !== initialUrl.trim() ||
          next.method !== initialMethod ||
          (next.method === 'bearer' && next.token.trim() !== initialToken.trim())
      );
    },
    [fieldsWith, server, onDirtyChange, initialName, initialUrl, initialMethod, initialToken]
  );

  /**
   * Points the token field at the endpoint the URL text now names, through the
   * transitions above. Only a replacement of the text the field shows remounts
   * it; a keystroke never does.
   */
  const retargetToken = useCallback(
    (nextUrl: string) => {
      if (server === undefined) {
        return;
      }
      const next = retargetTokenField(tokenField.current, savedEndpoint, endpointOf(nextUrl));
      if (next.field === tokenField.current) {
        return;
      }
      tokenField.current = next.field;
      if (next.remount) {
        setTokenFieldKey(key => key + 1);
      }
    },
    [server, savedEndpoint]
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
      // A value is the person's own only when they typed it, and that is what
      // the store is told.
      onSave({ ...draft, tokenEntered: tokenField.current.kind === 'typed' });
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
          retargetToken(value);
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
          key={tokenFieldKey}
          label={t('modelChat.mcpOAuth.fieldToken')}
          defaultValue={tokenText(tokenField.current, initialToken)}
          error={
            tokenField.current.kind === 'retargeted' && errors?.token !== undefined
              ? t(errors.token)
              : undefined
          }
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          onChangeText={value => {
            /* The field is already showing this text, so it is not mounted
               again: the value and the reason line update together. */
            tokenField.current = { kind: 'typed', text: value, endpoint: endpointOf(url.current) };
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
