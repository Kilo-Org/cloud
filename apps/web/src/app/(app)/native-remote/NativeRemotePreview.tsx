'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import {
  NativeSyncClient,
  listNativeModels,
  readNativeConversation,
  type NativePendingQuestion,
  type NativePresenceState,
  type NativeSessionState,
  type NativePresenceConnection,
  type NativeSessionConnection,
} from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useUrlOrganizationId } from '@/hooks/useUrlOrganizationId';
import { CloudReadOnlyThread } from '@/components/cloud-agent-next/assistant-ui/CloudThread';
import { commandResult, commandRunner, sendNativePrompt } from './native-remote-events';

const tokenSchema = z.object({ token: z.string() });
const directoriesSchema = z.object({
  directory: z.string(),
  directories: z.array(z.object({ name: z.string(), directory: z.string() })),
});
const agentsSchema = z.object({ agents: z.array(z.object({ id: z.string(), name: z.string() })) });
const createdSchema = z.object({ sessionID: z.string() });
type NativeSelection = { id: string; organizationID?: string };

async function getCredential() {
  const response = await fetch('/api/native-remote/token', { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw new Error('Sign in to connect to native sessions.');
  return tokenSchema.parse(await response.json()).token;
}

export default function NativeRemotePreview() {
  const organizationID = useUrlOrganizationId() ?? undefined;
  return <NativeRemoteScope key={organizationID ?? 'personal'} organizationID={organizationID} />;
}

function NativeRemoteScope({ organizationID }: { organizationID: string | undefined }) {
  const client = useMemo(
    () =>
      new NativeSyncClient({
        baseUrl: process.env.NEXT_PUBLIC_SESSION_SYNC_URL || 'http://localhost:8817',
        getCredential,
      }),
    []
  );
  const [presence, setPresence] = useState<NativePresenceState>({
    connection: 'connecting',
    instances: [],
  });
  const presenceRef = useRef<NativePresenceConnection | null>(null);
  const [instanceID, setInstanceID] = useState('');
  const [directory, setDirectory] = useState('');
  const [model, setModel] = useState('');
  const [agent, setAgent] = useState('');
  const [session, setSession] = useState<NativeSelection>();
  const [sessionState, setSessionState] = useState<{
    selection: NativeSelection;
    state: NativeSessionState;
  }>();
  const state = sessionState?.selection === session ? sessionState?.state : undefined;
  const sessionRef = useRef<NativeSessionConnection | null>(null);
  const [prompt, setPrompt] = useState('');
  const [queue, setQueue] = useState(false);
  const [error, setError] = useState('');
  const [commandID, setCommandID] = useState('');
  const online = presence.instances.filter(instance => instance.online);
  const selected = online.find(instance => instance.instanceID === instanceID);

  useEffect(() => {
    const connection = client.connectPresence(setPresence, organizationID);
    presenceRef.current = connection;
    return () => {
      presenceRef.current = null;
      connection.close();
    };
  }, [client, organizationID]);
  useEffect(() => {
    setSessionState(undefined);
    if (!session) return;
    let active = true;
    const connection = client.connectSession(
      session.id,
      value => {
        if (active) setSessionState({ selection: session, state: value });
      },
      session.organizationID
    );
    sessionRef.current = connection;
    return () => {
      active = false;
      sessionRef.current = null;
      connection.close();
    };
  }, [client, session]);

  const sessions = useInfiniteQuery({
    queryKey: ['native-remote', 'sessions'],
    queryFn: ({ pageParam }) => client.listSessions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.cursor ?? undefined,
    refetchInterval: 10000,
  });
  const discovery = useQuery({
    queryKey: ['native-remote', 'discovery', organizationID, instanceID],
    enabled: Boolean(selected),
    retry: false,
    queryFn: async () => {
      const connection = presenceRef.current;
      if (!connection) throw new Error('Host connection unavailable');
      const call = async (type: 'list_directories' | 'list_agents') => {
        const reply = await connection.command(instanceID, type, {});
        if (reply.status === 'unknown')
          throw new Error('Discovery outcome unknown. Refresh to try again.');
        return commandResult(reply.body);
      };
      const [directories, models, agents] = await Promise.all([
        call('list_directories'),
        listNativeModels(connection, instanceID),
        call('list_agents'),
      ]);
      return {
        directories: directoriesSchema.parse(directories),
        models: { models },
        agents: agentsSchema.parse(agents),
      };
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const connection = presenceRef.current;
      if (!connection || !selected) throw new Error('Select an online host');
      const chosenModel = discovery.data?.models.models.find(
        item => `${item.providerID}/${item.id}` === model
      );
      const reply = await connection.command(instanceID, 'create_session', {
        ...(directory ? { directory } : {}),
        ...(agent ? { agent } : {}),
        ...(chosenModel
          ? { model: { providerID: chosenModel.providerID, id: chosenModel.id } }
          : {}),
      });
      if (reply.status === 'unknown')
        throw new Error('Creation outcome unknown. Refresh sessions before retrying.');
      return createdSchema.parse(commandResult(reply.body));
    },
    onSuccess: result => {
      setSession({
        id: result.sessionID,
        organizationID: selected?.tenant.type === 'organization' ? selected.tenant.id : undefined,
      });
      void sessions.refetch();
    },
  });
  const run = useMemo(
    () =>
      commandRunner(outcome => {
        if (outcome.error !== undefined) setError(outcome.error);
        if (outcome.commandID !== undefined) setCommandID(outcome.commandID);
      }),
    []
  );
  async function submit() {
    const connection = sessionRef.current;
    if (!connection || !prompt.trim()) return;
    if (await run('prompt', () => sendNativePrompt(connection, prompt, queue))) setPrompt('');
  }
  const conversation = useMemo(() => (state ? readNativeConversation(state) : undefined), [state]);
  const pending = conversation?.pending ?? { permissions: [], questions: [] };
  const canControl = state?.connection === 'connected' && state.runnerConnected;
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold">Native remote demo</h1>
        <p className="text-muted-foreground text-sm">
          Creator-owned native sessions · Hosts: {presence.connection}
        </p>
      </header>
      <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Native sessions">
        <h2 className="font-medium">Your sessions</h2>
        {sessions.isPending && <p role="status">Loading sessions…</p>}
        {sessions.error && <p role="alert">{sessions.error.message}</p>}
        {sessions.data?.pages.every(page => page.items.length === 0) && (
          <p className="text-muted-foreground">
            No native sessions yet. Start a remote host to create one.
          </p>
        )}
        {sessions.data?.pages
          .flatMap(page => page.items)
          .map(item => (
            <Button
              key={item.sessionID}
              variant="outline"
              className="justify-start"
              onClick={() =>
                setSession({
                  id: item.sessionID,
                  organizationID: item.tenant.type === 'organization' ? item.tenant.id : undefined,
                })
              }
            >
              {item.live ? 'Live' : 'Offline'} · {item.sessionID}
            </Button>
          ))}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void sessions.refetch()}>
            Refresh sessions
          </Button>
          {sessions.hasNextPage && (
            <Button
              variant="outline"
              disabled={sessions.isFetchingNextPage}
              onClick={() => void sessions.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </div>
      </section>
      <section
        className="flex flex-col gap-3 rounded-lg border p-4"
        aria-label="Create native session"
      >
        <h2 className="font-medium">Create on an online host</h2>
        <label>
          Host
          <select
            className="border-input bg-background mt-1 block w-full rounded-md border p-2"
            value={instanceID}
            onChange={event => {
              setInstanceID(event.target.value);
              setDirectory('');
              setModel('');
              setAgent('');
            }}
          >
            <option value="">Select a host</option>
            {online.map(instance => (
              <option key={instance.instanceID} value={instance.instanceID}>
                {instance.advertisement.name} · {instance.advertisement.projectName}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <>
            <label>
              Directory
              <Input
                list="native-directories"
                value={directory}
                placeholder={discovery.data?.directories.directory ?? 'Launch directory'}
                onChange={event => setDirectory(event.target.value)}
              />
            </label>
            <datalist id="native-directories">
              {discovery.data?.directories.directories.map(item => (
                <option key={item.directory} value={item.directory}>
                  {item.name}
                </option>
              ))}
            </datalist>
            {discovery.isPending && <p role="status">Loading host options…</p>}
            {discovery.isSuccess && discovery.data.models.models.length === 0 && (
              <p className="text-muted-foreground">No models advertised. Using the host default.</p>
            )}
            <label>
              Model
              <select
                className="border-input bg-background ml-2 rounded-md border p-2"
                value={model}
                onChange={event => setModel(event.target.value)}
              >
                <option value="">Host default</option>
                {discovery.data?.models.models.map(item => (
                  <option
                    key={`${item.providerID}/${item.id}`}
                    value={`${item.providerID}/${item.id}`}
                  >
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Agent
              <select
                className="border-input bg-background ml-2 rounded-md border p-2"
                value={agent}
                onChange={event => setAgent(event.target.value)}
              >
                <option value="">Host default</option>
                {discovery.data?.agents.agents.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              disabled={discovery.isFetching}
              onClick={() => void discovery.refetch()}
            >
              Refresh host options
            </Button>
          </>
        )}
        <Button
          disabled={
            !selected || create.isPending || discovery.isPending || Boolean(discovery.error)
          }
          onClick={() => create.mutate()}
        >
          Create session
        </Button>
        {(create.error || discovery.error || presence.error) && (
          <p role="alert">{create.error?.message ?? discovery.error?.message ?? presence.error}</p>
        )}
      </section>
      {session && (
        <section
          className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
          aria-label="Session transcript"
        >
          <h2 className="break-all font-mono text-sm">{session.id}</h2>
          <p role="status">
            Relay: {state?.connection ?? 'connecting'} · Runner:{' '}
            {state?.runnerConnected ? 'online' : 'offline'}
          </p>
          <div className="max-h-96 space-y-3 overflow-auto" aria-live="polite">
            {(!conversation || conversation.loading) && <p role="status">Loading transcript…</p>}
            {conversation?.session && (
              <CloudReadOnlyThread
                messages={conversation.messages}
                isStreaming={conversation.messages.some(
                  message =>
                    message.info.role === 'assistant' && message.info.time.completed === undefined
                )}
                presentationMode="live"
              />
            )}
            {conversation?.session &&
              conversation.messages.length === 0 &&
              conversation.incompleteMessageIDs.length === 0 && (
                <p className="text-muted-foreground text-sm">This session has no messages yet.</p>
              )}
          </div>
          {pending.permissions.map(request => (
            <div className="space-y-2 rounded border p-3" key={request.id}>
              <p>Permission: {request.action}</p>
              <pre className="whitespace-pre-wrap text-sm">{request.resources.join('\n')}</pre>
              {request.message && <p>{request.message}</p>}
              <div className="flex gap-2">
                <Button
                  disabled={!canControl}
                  onClick={() => {
                    const connection = sessionRef.current;
                    if (connection)
                      void run(`permission:${request.id}`, () =>
                        connection.respondPermission(request.id, 'once')
                      );
                  }}
                >
                  Allow once
                </Button>
                <Button
                  variant="outline"
                  disabled={!canControl}
                  onClick={() => {
                    const connection = sessionRef.current;
                    if (connection)
                      void run(`permission:${request.id}`, () =>
                        connection.respondPermission(request.id, 'reject')
                      );
                  }}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
          {pending.questions.map(question => (
            <Question
              key={question.id}
              question={question}
              disabled={!canControl}
              reply={answers => {
                const connection = sessionRef.current;
                if (connection)
                  void run(`question:${question.id}`, () =>
                    connection.replyQuestion(question.id, answers)
                  );
              }}
              reject={() => {
                const connection = sessionRef.current;
                if (connection)
                  void run(`question:${question.id}`, () => connection.rejectQuestion(question.id));
              }}
            />
          ))}
          <label>
            Prompt
            <Textarea
              value={prompt}
              onChange={event => setPrompt(event.target.value)}
              placeholder="Message or /compact, /new, /skill, /models, /agents, /clear"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={queue}
              onChange={event => setQueue(event.target.checked)}
            />
            Queue messages while the runner is offline
          </label>
          <div className="flex gap-2">
            <Button
              disabled={
                !prompt.trim() ||
                state?.connection !== 'connected' ||
                (!state.runnerConnected && !queue)
              }
              onClick={() => void submit()}
            >
              Send
            </Button>
            <Button
              variant="outline"
              disabled={!canControl}
              onClick={() => {
                const connection = sessionRef.current;
                if (connection) void run('abort', () => connection.interrupt());
              }}
            >
              Abort
            </Button>
            <Button variant="ghost" onClick={() => sessionRef.current?.clear()}>
              Clear local view
            </Button>
          </div>
          {(error || conversation?.error) && <p role="alert">{error || conversation?.error}</p>}
          {commandID && <p className="break-all text-sm">Last command: {commandID}</p>}
          <ul className="text-muted-foreground text-xs">
            {Object.entries(state?.commands ?? {}).map(([id, status]) => (
              <li key={id}>
                {id}: {status} (delivery, not execution)
              </li>
            ))}
          </ul>
          {state?.events
            .filter(event => event.type === 'command.outcome')
            .map(event => (
              <pre key={event.seq} className="overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(event.body, null, 2)}
              </pre>
            ))}
        </section>
      )}
    </main>
  );
}

function Question({
  question,
  disabled,
  reply,
  reject,
}: {
  question: NativePendingQuestion;
  disabled: boolean;
  reply: (answers: string[][]) => void;
  reject: () => void;
}) {
  const [answers, setAnswers] = useState<string[][]>(() => question.fields.map(() => []));
  return (
    <form
      className="space-y-3 rounded border p-3"
      onSubmit={event => {
        event.preventDefault();
        reply(answers);
      }}
    >
      <h3>{question.title ?? 'Question'}</h3>
      {question.fields.map((field, index) => (
        <label className="block" key={field.key}>
          {field.title ?? field.description ?? field.key}
          {field.options && !field.custom ? (
            <select
              multiple={field.type === 'multiselect'}
              className="bg-background block rounded border p-2"
              value={field.type === 'multiselect' ? answers[index] : (answers[index]?.[0] ?? '')}
              onChange={event =>
                setAnswers(previous =>
                  previous.map((answer, at) =>
                    at === index
                      ? Array.from(event.target.selectedOptions, option => option.value)
                      : answer
                  )
                )
              }
            >
              <option value="" disabled>
                Select an answer
              </option>
              {field.options.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label ?? option.value}
                </option>
              ))}
            </select>
          ) : (
            <Textarea
              value={answers[index]?.join('\n') ?? ''}
              placeholder={field.type === 'multiselect' ? 'One answer per line' : undefined}
              onChange={event =>
                setAnswers(previous =>
                  previous.map((answer, at) =>
                    at === index
                      ? field.type === 'multiselect'
                        ? event.target.value.split('\n')
                        : [event.target.value]
                      : answer
                  )
                )
              }
            />
          )}
        </label>
      ))}
      <div className="flex gap-2">
        <Button disabled={disabled} type="submit">
          Reply
        </Button>
        <Button disabled={disabled} variant="outline" type="button" onClick={reject}>
          Reject question
        </Button>
      </div>
    </form>
  );
}
