import { listDirectoriesOnConnection } from './list-directories';
import { listDirectoriesV1Schema } from './schemas';
import { CommandDeliveredError, UserWebCommandError } from './user-web-connection';

function makeFakeConnection() {
  return {
    sendCommandToConnection: jest.fn(),
  };
}

describe('listDirectoriesOnConnection', () => {
  it('sends list_directories with protocolVersion 1 and omits path when undefined', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      path: '',
      directories: [],
    });

    const result = await listDirectoriesOnConnection(connection, 'cli-owner-1');

    expect(result).toEqual({ ok: true, path: '', directories: [] });
    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(1);
    expect(connection.sendCommandToConnection).toHaveBeenCalledWith({
      command: 'list_directories',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
  });

  it('forwards path in the wire data when provided', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      path: 'src',
      directories: [],
    });

    await listDirectoriesOnConnection(connection, 'cli-owner-1', 'src');

    expect(connection.sendCommandToConnection).toHaveBeenCalledWith({
      command: 'list_directories',
      data: { protocolVersion: 1, path: 'src' },
      expectedConnectionId: 'cli-owner-1',
    });
  });

  it('parses a valid listing with directories', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      path: 'src',
      directories: [
        { name: 'app', path: 'src/app' },
        { name: 'lib', path: 'src/lib' },
      ],
    });

    await expect(listDirectoriesOnConnection(connection, 'cli-owner-1', 'src')).resolves.toEqual({
      ok: true,
      path: 'src',
      directories: [
        { name: 'app', path: 'src/app' },
        { name: 'lib', path: 'src/lib' },
      ],
    });
  });

  it('classifies a resolved payload outside the strict schema as invalid', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      path: 'src',
      directories: [{ name: 'app', path: 'src/app' }],
      sneaky: 'value',
    });

    await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('classifies an old-CLI unknown command as unsupported', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('unknown command: list_directories')
    );

    await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('classifies an invalid-request delivery as unsupported', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('invalid list_directories request')
    );

    await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('classifies invalid list_directories path as transport', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('invalid list_directories path')
    );

    await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'transport',
    });
  });

  it('classifies failed to list directories as transport', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('failed to list directories')
    );

    await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'transport',
    });
  });

  it('classifies CLI_UPGRADE_REQUIRED as unsupported', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new UserWebCommandError({ code: 'CLI_UPGRADE_REQUIRED', message: 'upgrade required' })
    );

    await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('classifies every retryable relay code as transport', async () => {
    const retryableCodes = [
      'SESSION_OWNER_CHANGED',
      'CATALOG_REQUEST_PENDING',
      'COMMAND_EXPIRED',
      'PENDING_COMMAND_LIMIT',
    ];

    for (const code of retryableCodes) {
      const connection = makeFakeConnection();
      connection.sendCommandToConnection.mockRejectedValue(
        new UserWebCommandError({ code, message: 'try again' })
      );

      await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
        ok: false,
        reason: 'transport',
      });
    }
  });

  it('classifies a plain transport-level rejection as transport', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(new Error('Command timed out'));

    await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
      ok: false,
      reason: 'transport',
    });
  });

  it('classifies an unexpected strict-parse throw as transport and never rejects', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({ any: 'payload' });
    const parseSpy = jest.spyOn(listDirectoriesV1Schema, 'safeParse').mockImplementation(() => {
      throw new Error('strict parse exploded');
    });
    try {
      await expect(listDirectoriesOnConnection(connection, 'cli-owner-1')).resolves.toEqual({
        ok: false,
        reason: 'transport',
      });
    } finally {
      parseSpy.mockRestore();
    }
  });
});
