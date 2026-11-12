import vercelConfig from '../../../../vercel.json';

describe('apps/web/vercel.json schedules', () => {
  const schedules = Object.values(vercelConfig.schedules);

  it('does not also run a scheduled path as a legacy cron job', () => {
    const cronPaths = new Set(vercelConfig.crons.map(cron => cron.path));

    expect(schedules.filter(schedule => cronPaths.has(schedule.path))).toEqual([]);
  });

  it('calls the GET handlers that cron routes export', () => {
    expect(schedules.filter(schedule => schedule.requestMethod !== 'GET')).toEqual([]);
  });
});
