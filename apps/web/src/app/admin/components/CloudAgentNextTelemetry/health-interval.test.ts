import { rollingHealthInterval } from './health-interval';

describe('rollingHealthInterval', () => {
  it('ends the range at the exact refresh time', () => {
    expect(
      rollingHealthInterval(
        { durationMs: 3 * 60 * 60 * 1000 },
        new Date('2035-01-10T12:34:56.789Z')
      )
    ).toEqual({
      startDate: '2035-01-10T09:34:56.789Z',
      endDate: '2035-01-10T12:34:56.789Z',
    });
  });
});
