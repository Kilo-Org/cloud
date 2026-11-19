import type { AgentBoard } from '@kilocode/session-ingest-contracts';
import { agentAvatarIdentity, projectAgentBoard, type AgentBoardParticipant } from './agent-board';

const message = (
  id: string,
  fields: Partial<AgentBoard['messages'][number]>
): AgentBoard['messages'][number] => ({
  id,
  timestamp: 1,
  from: 'main',
  to: 'main',
  type: 'INFO',
  body: 'Body',
  ...fields,
});

describe('agent avatar identity', () => {
  it('matches the Kilo UI glyphs and colors for the same agent', () => {
    expect(agentAvatarIdentity('ses_alpha')).toEqual({
      color: 1,
      cells: [2, 7, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 23],
    });
    expect(agentAvatarIdentity('ses_beta')).toEqual({
      color: 7,
      cells: [7, 11, 12, 13, 15, 16, 17, 18, 19],
    });
  });
});

describe('projectAgentBoard', () => {
  const board: AgentBoard = {
    ownerSessionID: 'ses_root',
    revision: 3,
    hasMore: false,
    messages: [
      message('board_1', { from: 'main', to: 'ses_alpha', toLabel: 'Inspect upload' }),
      message('board_2', {
        from: 'ses_alpha',
        fromLabel: 'Inspect upload',
        to: 'ALL',
        body: '**Found** it',
      }),
      message('board_3', { from: 'ses_beta', to: 'main', type: 'RESULT' }),
    ],
  };

  it('names the primary agent, labeled agents, and unlabeled agents', () => {
    const rows = projectAgentBoard(board);
    expect(rows[0]).toMatchObject({
      from: { kind: 'main', label: 'Primary agent' },
      to: { label: 'Inspect upload', participants: [{ kind: 'agent', sessionId: 'ses_alpha' }] },
    });
    expect(rows[2]).toMatchObject({
      from: { kind: 'agent', sessionId: 'ses_beta', label: 'Agent' },
      to: { label: 'Primary agent' },
    });
  });

  it('addresses a message to all agents to the other participants already on the board', () => {
    const ids = (row: { to: { participants: readonly AgentBoardParticipant[] } }) =>
      row.to.participants.map(participant =>
        participant.kind === 'main' ? 'main' : participant.sessionId
      );
    const [, broadcast] = projectAgentBoard(board);
    expect(broadcast.to.label).toBe('All agents');
    expect(ids(broadcast)).toEqual(['main']);
    expect(broadcast.body).toBe('**Found** it');
    const later = projectAgentBoard({
      ...board,
      messages: [...board.messages, message('board_4', { from: 'main', to: 'ALL' })],
    });
    expect(ids(later[3])).toEqual(['ses_alpha', 'ses_beta']);
  });

  it('keeps the message body and does not expose the message type', () => {
    const rows = projectAgentBoard(board);
    expect(rows.map(row => Object.keys(row).sort())).toEqual(
      rows.map(() => ['body', 'from', 'id', 'to'])
    );
  });

  it('gives sibling agents distinct colors', () => {
    const agents = Array.from({ length: 8 }, (_, index) => `ses_agent_${index}`);
    const rows = projectAgentBoard({
      ...board,
      messages: agents.map(id => message(`board_${id}`, { from: id })),
    });
    const colors = rows.map(row => (row.from.kind === 'agent' ? row.from.color : -1));
    expect(new Set(colors).size).toBe(8);
  });
});
