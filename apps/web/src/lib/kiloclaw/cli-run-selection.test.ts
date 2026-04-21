import { selectCurrentCliRun } from './cli-run-selection';

describe('selectCurrentCliRun', () => {
  const runs = [
    { id: 'preferred-other', instance_id: 'other-instance', status: 'completed' },
    { id: 'running-current', instance_id: 'current-instance', status: 'running' },
    { id: 'completed-current', instance_id: 'current-instance', status: 'completed' },
  ];

  it('does not select a preferred run from another instance', () => {
    expect(selectCurrentCliRun(runs, 'current-instance', 'preferred-other')?.id).toBe(
      'running-current'
    );
  });

  it('selects a preferred run from the current instance', () => {
    expect(selectCurrentCliRun(runs, 'current-instance', 'completed-current')?.id).toBe(
      'completed-current'
    );
  });
});
