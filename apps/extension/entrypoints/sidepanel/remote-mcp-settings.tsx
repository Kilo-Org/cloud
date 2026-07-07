/* eslint-disable max-lines */
import { storage } from '#imports';
import { useAtom } from 'jotai';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { RemoteMcpServer } from '../../src/shared/remote-mcp';
import { loadRemoteMcpStore, saveRemoteMcpStore } from '../../src/shared/remote-mcp-storage';
import { remoteMcpStoreAtom } from './agent-chat-atoms';
import { connectAndPersistRemoteMcpServer } from './remote-mcp-client';
import {
  applyUpsert,
  buildDraftFromForm,
  formatLastConnected,
  formatToolCount,
  getConnectButtonLabel,
  isSecretSaved,
  removeServer,
  toolsToJsonString,
} from './remote-mcp-settings-logic';

type AuthType = 'none' | 'bearer' | 'header' | 'oauth';

interface FormState {
  allowInSafeMode: boolean;
  authType: AuthType;
  bearerToken: string;
  displayName: string;
  enabled: boolean;
  headerName: string;
  headerValue: string;
  id?: string;
  url: string;
}

const authTypeValues: AuthType[] = ['none', 'bearer', 'header', 'oauth'];

const isAuthType = (value: string): value is AuthType =>
  (authTypeValues as string[]).includes(value);

const defaultForm = (): FormState => ({
  allowInSafeMode: false,
  authType: 'none',
  bearerToken: '',
  displayName: '',
  enabled: true,
  headerName: '',
  headerValue: '',
  url: '',
});

const formFromServer = (server: RemoteMcpServer): FormState => {
  const { auth } = server;
  const authType: AuthType =
    auth.type === 'bearer' || auth.type === 'header' || auth.type === 'oauth' ? auth.type : 'none';
  const headerName = auth.type === 'header' ? auth.headerName : '';
  return {
    allowInSafeMode: server.allowInSafeMode,
    authType,
    bearerToken: '',
    displayName: server.displayName,
    enabled: server.enabled,
    headerName,
    headerValue: '',
    id: server.id,
    url: server.url,
  };
};

const inputClass =
  'h-8 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200 outline-none transition hover:border-zinc-700 focus:border-[#EDFF00] focus:ring-2 focus:ring-[#EDFF00]/30';

const labelClass = 'text-xs font-medium text-zinc-500';

const SavedSecret = ({ onReplace }: { onReplace: () => void }): JSX.Element => (
  <div className="flex items-center gap-2">
    <span className="text-sm text-zinc-500">••••••• saved</span>
    <button
      className="text-xs text-zinc-400 underline hover:text-zinc-200"
      onClick={onReplace}
      type="button"
    >
      Replace
    </button>
  </div>
);

const Field = ({
  children,
  htmlFor,
  label,
}: {
  children: JSX.Element;
  htmlFor: string;
  label: string;
}): JSX.Element => (
  <div className="flex flex-col gap-1">
    <label className={labelClass} htmlFor={htmlFor}>
      {label}
    </label>
    {children}
  </div>
);

const SecretField = ({
  htmlFor,
  label,
  onChange,
  onReplace,
  placeholder,
  saved,
  show,
  value,
}: {
  htmlFor: string;
  label: string;
  onChange: (value: string) => void;
  onReplace: () => void;
  placeholder: string;
  saved: boolean;
  show: boolean;
  value: string;
}): JSX.Element => (
  <Field htmlFor={htmlFor} label={label}>
    {saved && !show ? (
      <SavedSecret onReplace={onReplace} />
    ) : (
      <input
        className={inputClass}
        id={htmlFor}
        onChange={ev => {
          onChange(ev.target.value);
        }}
        placeholder={placeholder}
        type="password"
        value={value}
      />
    )}
  </Field>
);

const ServerForm = ({
  existingServer,
  onCancel,
  onSave,
}: {
  existingServer?: RemoteMcpServer;
  onCancel: () => void;
  onSave: (form: FormState) => Promise<string | null>;
}): JSX.Element => {
  const [form, setForm] = useState<FormState>(
    existingServer === undefined ? defaultForm() : formFromServer(existingServer)
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showBearerInput, setShowBearerInput] = useState(false);
  const [showHeaderValueInput, setShowHeaderValueInput] = useState(false);
  const secretSaved = isSecretSaved(existingServer) && existingServer?.auth.type === form.authType;

  const set = <Key extends keyof FormState>(key: Key, value: FormState[Key]): void => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (ev: { preventDefault: () => void }): Promise<void> => {
    ev.preventDefault();
    setError(null);
    setSaving(true);
    const saveError = await onSave(form);
    setSaving(false);
    if (saveError !== null) {
      setError(saveError);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={ev => void handleSubmit(ev)}>
      <Field htmlFor="displayName" label="Name">
        <input
          className={inputClass}
          id="displayName"
          onChange={ev => {
            set('displayName', ev.target.value);
          }}
          placeholder="My MCP Server"
          required
          type="text"
          value={form.displayName}
        />
      </Field>
      <Field htmlFor="url" label="URL">
        <input
          className={inputClass}
          id="url"
          onChange={ev => {
            set('url', ev.target.value);
          }}
          placeholder="https://example.com/mcp"
          required
          type="text"
          value={form.url}
        />
      </Field>
      <Field htmlFor="authType" label="Auth">
        <select
          className={inputClass}
          id="authType"
          onChange={ev => {
            const { value } = ev.target;
            if (isAuthType(value)) {
              set('authType', value);
            }
          }}
          value={form.authType}
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
          <option value="oauth">OAuth</option>
        </select>
      </Field>
      {form.authType === 'bearer' ? (
        <SecretField
          htmlFor="bearerToken"
          label="Bearer token"
          onChange={value => {
            set('bearerToken', value);
          }}
          onReplace={() => {
            setShowBearerInput(true);
          }}
          placeholder="Token"
          saved={secretSaved}
          show={showBearerInput}
          value={form.bearerToken}
        />
      ) : null}
      {form.authType === 'header' ? (
        <>
          <Field htmlFor="headerName" label="Header name">
            <input
              className={inputClass}
              id="headerName"
              onChange={ev => {
                set('headerName', ev.target.value);
              }}
              placeholder="X-Api-Key"
              required
              type="text"
              value={form.headerName}
            />
          </Field>
          <SecretField
            htmlFor="headerValue"
            label="Header value"
            onChange={value => {
              set('headerValue', value);
            }}
            onReplace={() => {
              setShowHeaderValueInput(true);
            }}
            placeholder="Value"
            saved={secretSaved}
            show={showHeaderValueInput}
            value={form.headerValue}
          />
        </>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          checked={form.enabled}
          className="rounded border-zinc-700"
          id="enabled"
          onChange={ev => {
            set('enabled', ev.target.checked);
          }}
          type="checkbox"
        />
        <label className="text-sm text-zinc-300" htmlFor="enabled">
          Enabled
        </label>
      </div>
      <div className="flex items-center gap-2">
        <input
          checked={form.allowInSafeMode}
          className="rounded border-zinc-700"
          id="allowInSafeMode"
          onChange={ev => {
            set('allowInSafeMode', ev.target.checked);
          }}
          type="checkbox"
        />
        <label className="text-sm text-zinc-300" htmlFor="allowInSafeMode">
          Allow in safe mode
        </label>
      </div>
      {error === null ? null : <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          className="h-9 flex-1 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:opacity-50"
          disabled={saving}
          type="submit"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="h-9 rounded-md border border-zinc-800 px-3 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
};

const ServerRow = ({
  onConnect,
  onEdit,
  onRemove,
  server,
}: {
  onConnect: (server: RemoteMcpServer) => Promise<void>;
  onEdit: (server: RemoteMcpServer) => void;
  onRemove: (serverId: string) => void;
  server: RemoteMcpServer;
}): JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async (): Promise<void> => {
    setConnecting(true);
    try {
      await onConnect(server);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="min-w-0 rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <button
            className="flex items-center gap-1 text-left"
            onClick={() => {
              setExpanded(prev => !prev);
            }}
            type="button"
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-zinc-500" />
            )}
            <span className="text-sm font-medium text-zinc-100">{server.displayName}</span>
          </button>
          <p className="ml-5 truncate text-xs text-zinc-500">{server.url}</p>
          <p className="ml-5 text-xs text-zinc-500">
            {formatToolCount(server.cachedTools.length)} ·{' '}
            {formatLastConnected(server.lastConnectedAt)}
          </p>
          {server.lastError === undefined ? null : (
            <p className="ml-5 truncate text-xs text-red-400">{server.lastError}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="flex h-9 items-center gap-1 rounded-md border border-zinc-700 px-2 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950 disabled:opacity-50"
            disabled={connecting}
            onClick={() => void handleConnect()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className="size-3" />
            {connecting ? 'Connecting…' : getConnectButtonLabel(server.status)}
          </button>
          <button
            aria-label={`Edit ${server.displayName}`}
            className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
            onClick={() => {
              onEdit(server);
            }}
            type="button"
          >
            <Server aria-hidden="true" className="size-4" />
          </button>
          <button
            aria-label={`Remove ${server.displayName}`}
            className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-red-400 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
            onClick={() => {
              onRemove(server.id);
            }}
            type="button"
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      {expanded && server.cachedTools.length > 0 ? (
        <div className="mt-2 overflow-x-auto">
          <pre className="font-mono text-xs text-zinc-400">
            {toolsToJsonString(server.cachedTools)}
          </pre>
        </div>
      ) : null}
    </div>
  );
};

export const RemoteMcpSettings = (): JSX.Element => {
  const [store, setStore] = useAtom(remoteMcpStoreAtom);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingServer, setEditingServer] = useState<RemoteMcpServer | null>(null);

  useEffect(() => {
    void (async () => {
      setStore(await loadRemoteMcpStore(storage));
    })();
  }, [setStore]);

  const handleConnect = async (server: RemoteMcpServer): Promise<void> => {
    const nextServers = await connectAndPersistRemoteMcpServer({
      fetch: globalThis.fetch,
      server,
      storageArea: storage,
    });
    if (nextServers !== undefined) {
      setStore({ servers: nextServers });
    }
  };

  const handleSave = async (form: FormState): Promise<string | null> => {
    const existing = editingServer;
    const draft = buildDraftFromForm(form, existing?.auth);
    const { store: nextStore, error } = applyUpsert(store, draft);
    if (error !== null) {
      return error;
    }
    await saveRemoteMcpStore(storage, nextStore);
    setStore(nextStore);
    setShowAddForm(false);
    setEditingServer(null);

    // Connect (test) on save so tools are cached and usable immediately; the row surfaces any failure.
    const savedServer =
      existing === null
        ? nextStore.servers.find(candidate => !store.servers.some(prev => prev.id === candidate.id))
        : nextStore.servers.find(candidate => candidate.id === existing.id);
    if (savedServer !== undefined) {
      const nextServers = await connectAndPersistRemoteMcpServer({
        fetch: globalThis.fetch,
        server: savedServer,
        storageArea: storage,
      });
      if (nextServers !== undefined) {
        setStore({ servers: nextServers });
      }
    }
    return null;
  };

  const handleRemove = async (serverId: string): Promise<void> => {
    const nextStore = removeServer(store, serverId);
    await saveRemoteMcpStore(storage, nextStore);
    setStore(nextStore);
  };

  const handleEdit = (server: RemoteMcpServer): void => {
    setEditingServer(server);
    setShowAddForm(false);
  };

  const handleCancelForm = (): void => {
    setShowAddForm(false);
    setEditingServer(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className={labelClass}>Remote MCP servers</p>
      {store.servers.map(server =>
        editingServer?.id === server.id ? (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3" key={server.id}>
            <ServerForm existingServer={server} onCancel={handleCancelForm} onSave={handleSave} />
          </div>
        ) : (
          <ServerRow
            key={server.id}
            onConnect={handleConnect}
            onEdit={handleEdit}
            onRemove={serverId => void handleRemove(serverId)}
            server={server}
          />
        )
      )}
      {showAddForm ? (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
          <ServerForm onCancel={handleCancelForm} onSave={handleSave} />
        </div>
      ) : (
        <button
          className="flex h-9 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-400 transition hover:border-zinc-600 hover:bg-zinc-900 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
          onClick={() => {
            setEditingServer(null);
            setShowAddForm(true);
          }}
          type="button"
        >
          <Plus aria-hidden="true" className="size-4" />
          Add server
        </button>
      )}
    </div>
  );
};
