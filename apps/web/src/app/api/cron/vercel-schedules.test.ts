import vercelConfig from '../../../../vercel.json';

describe('apps/web/vercel.json schedules', () => {
  const schedules = Object.values(vercelConfig.schedules);

  it('declares no legacy cron jobs', () => {
    expect(vercelConfig).not.toHaveProperty('crons');
  });

  it('calls the GET handlers that cron routes export', () => {
    expect(schedules.filter(schedule => schedule.requestMethod !== 'GET')).toEqual([]);
  });

  it('schedules each path once', () => {
    const paths = schedules.map(schedule => schedule.path);

    expect(paths.filter((path, index) => paths.indexOf(path) !== index)).toEqual([]);
  });
});
