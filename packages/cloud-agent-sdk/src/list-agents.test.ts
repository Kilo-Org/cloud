import { listAgents } from './list-agents';
import { CommandDeliveredError, UserWebCommandError } from './user-web-connection';

function makeFakeConnection() {
  return {
    sendCommand: jest.fn(),
    sendCommandToConnection: jest.fn(),
  };
}

const body = { protocolVersion: 1, agents: [{ name: 'swift-vibecoder', description: 'Swift' }] };

describe('listAgents', () => {
  it('asks the connection for the agents of a launch subdirectory', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue(body);

    const result = await listAgents(connection, { connectionId: 'cli-1', directory: 'app' });

    expect(result).toEqual({ ok: true, agents: body.agents });
    expect(connection.sendCommandToConnection).toHaveBeenCalledWith({
      command: 'list_agents',
      data: { protocolVersion: 1, directory: 'app' },
      expectedConnectionId: 'cli-1',
    });
  });

  it('omits an empty directory so the CLI uses its launch directory', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue(body);

    await listAgents(connection, { connectionId: 'cli-1', directory: '' });

    expect(connection.sendCommandToConnection).toHaveBeenCalledWith({
      command: 'list_agents',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-1',
    });
  });

  it('asks the session owner for the agents of a session', async () => {
    const connection = makeFakeConnection();
    connection.sendCommand.mockResolvedValue(body);

    await listAgents(connection, { sessionId: 'ses_1', ownerConnectionId: 'cli-1' });

    expect(connection.sendCommand).toHaveBeenCalledWith(
      'ses_1',
      'list_agents',
      { protocolVersion: 1 },
      'cli-1'
    );
    expect(connection.sendCommandToConnection).not.toHaveBeenCalled();
  });

  it('keeps agents when a newer CLI adds an unknown agent field', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      agents: [{ name: 'reviewer', model: 'kilo/x' }],
    });

    await expect(listAgents(connection, { connectionId: 'cli-1' })).resolves.toEqual({
      ok: true,
      agents: [{ name: 'reviewer' }],
    });
  });

  it('classifies a body outside the schema as invalid', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({ protocolVersion: 2, agents: [] });

    await expect(listAgents(connection, { connectionId: 'cli-1' })).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it.each([
    new CommandDeliveredError('unknown command: list_agents'),
    new CommandDeliveredError('invalid list_agents command'),
    new UserWebCommandError({ code: 'CLI_UPGRADE_REQUIRED', message: 'upgrade required' }),
  ])('classifies %p as unsupported', async error => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(error);

    await expect(listAgents(connection, { connectionId: 'cli-1' })).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it.each([
    new CommandDeliveredError('failed to list agents'),
    new CommandDeliveredError('invalid list_agents directory'),
    new UserWebCommandError({ code: 'COMMAND_EXPIRED', message: 'expired' }),
    new Error('socket closed'),
  ])('classifies %p as transport with its cause', async error => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(error);

    await expect(listAgents(connection, { connectionId: 'cli-1' })).resolves.toEqual({
      ok: false,
      reason: 'transport',
      cause: error,
    });
  });
});
