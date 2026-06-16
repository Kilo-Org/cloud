import type { CommandExecutor, CommandResult } from './command.js';
import { requireSuccess } from './command.js';
import { isRecord, parseJsonObject, parseJsonRecords, readString } from './json.js';
import { WEB_ENV_VAULT } from './plan.js';

export class OnePasswordAdapter {
  readonly #execute: CommandExecutor;
  #vaultId = '';

  constructor(execute: CommandExecutor) {
    this.#execute = execute;
  }

  async #run(args: string[], stdin?: string): Promise<CommandResult> {
    return this.#execute({
      command: 'op',
      args,
      stdin,
      timeoutMs: 120_000,
    });
  }

  async initialize(): Promise<void> {
    requireSuccess(await this.#run(['--version']), '1Password CLI version check');
    requireSuccess(
      await this.#run(['whoami', '--format=json']),
      '1Password authentication check; run op signin'
    );
    const vault = parseJsonObject(
      requireSuccess(
        await this.#run(['vault', 'get', WEB_ENV_VAULT, '--format=json']),
        `Resolve 1Password vault ${WEB_ENV_VAULT}`
      ),
      `Resolve 1Password vault ${WEB_ENV_VAULT}`
    );
    const vaultId = readString(vault, 'id');
    if (!vaultId) throw new Error(`1Password vault ${WEB_ENV_VAULT} did not include an ID.`);
    this.#vaultId = vaultId;
    await this.listItems();
  }

  async listItems(): Promise<{ id: string; title: string }[]> {
    if (!this.#vaultId) throw new Error('1Password vault has not been resolved.');
    const result = await this.#run(['item', 'list', '--vault', this.#vaultId, '--format=json']);
    const records = parseJsonRecords(
      requireSuccess(result, `List items in ${WEB_ENV_VAULT}`),
      `List items in ${WEB_ENV_VAULT}`
    );
    const items: { id: string; title: string }[] = [];
    for (const record of records) {
      const id = readString(record, 'id');
      const title = readString(record, 'title');
      if (id && title) items.push({ id, title });
    }
    return items;
  }

  async findItem(variableName: string): Promise<{ id: string; title: string } | undefined> {
    const matches = (await this.listItems()).filter(item => item.title === variableName);
    if (matches.length > 1) {
      throw new Error(`Multiple 1Password items are titled ${variableName}.`);
    }
    return matches[0];
  }

  async #createTemplate(variableName: string, value: string): Promise<string> {
    const result = await this.#run(['item', 'template', 'get', 'Password', '--format=json']);
    const template = parseJsonObject(
      requireSuccess(result, 'Load 1Password Password template'),
      'Load 1Password Password template'
    );
    template.title = variableName;
    this.#setPasswordField(template, value);
    return JSON.stringify(template);
  }

  #getPasswordField(item: Record<string, unknown>): Record<string, unknown> {
    const fields = item.fields;
    if (!Array.isArray(fields)) {
      throw new Error('1Password item did not include fields. Provider output was redacted.');
    }
    const passwordFields = fields.filter(
      field => isRecord(field) && (field.id === 'password' || field.label === 'password')
    );
    if (
      passwordFields.length !== 1 ||
      !isRecord(passwordFields[0]) ||
      readString(passwordFields[0], 'type') !== 'CONCEALED'
    ) {
      throw new Error('1Password item did not include one concealed password field.');
    }
    return passwordFields[0];
  }

  #setPasswordField(item: Record<string, unknown>, value: string): void {
    this.#getPasswordField(item).value = value;
  }

  async #readItem(itemId: string, variableName: string): Promise<Record<string, unknown>> {
    const getResult = await this.#run([
      'item',
      'get',
      itemId,
      '--vault',
      this.#vaultId,
      '--format=json',
    ]);
    return parseJsonObject(
      requireSuccess(getResult, `Read 1Password item ${variableName}`),
      `Read 1Password item ${variableName}`
    );
  }

  async validateExistingItem(
    variableName: string
  ): Promise<{ id: string; title: string } | undefined> {
    const existing = await this.findItem(variableName);
    if (!existing) return undefined;
    const item = await this.#readItem(existing.id, variableName);
    this.#getPasswordField(item);
    return existing;
  }

  async writeProductionValue(
    mode: 'add' | 'update' | 'resume',
    variableName: string,
    value: string
  ): Promise<void> {
    const existing = await this.findItem(variableName);
    if (mode === 'add' && existing) {
      throw new Error(`1Password already contains an item titled ${variableName}.`);
    }

    let itemId: string;
    if (!existing) {
      const template = await this.#createTemplate(variableName, value);
      const result = await this.#run(
        ['item', 'create', '--vault', this.#vaultId, '--format=json', '-'],
        template
      );
      const created = parseJsonObject(
        requireSuccess(result, `Create 1Password item ${variableName}`),
        `Create 1Password item ${variableName}`
      );
      const createdId = readString(created, 'id');
      if (!createdId) throw new Error(`Created 1Password item ${variableName} has no ID.`);
      itemId = createdId;
    } else {
      const item = await this.#readItem(existing.id, variableName);
      this.#setPasswordField(item, value);
      const editResult = await this.#run(
        ['item', 'edit', existing.id, '--vault', this.#vaultId, '--format=json'],
        JSON.stringify(item)
      );
      requireSuccess(editResult, `Update 1Password item ${variableName}`);
      itemId = existing.id;
    }

    const verifyResult = await this.#run([
      'item',
      'get',
      itemId,
      '--vault',
      this.#vaultId,
      '--fields',
      'label=password',
      '--format=json',
    ]);
    const passwordField = parseJsonObject(
      requireSuccess(verifyResult, `Verify 1Password item ${variableName}`),
      `Verify 1Password item ${variableName}`
    );
    if (
      readString(passwordField, 'type') !== 'CONCEALED' ||
      readString(passwordField, 'value') !== value
    ) {
      throw new Error(`1Password verification failed for ${variableName}.`);
    }
  }
}
