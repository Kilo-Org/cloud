import { commandKeyFromAlways } from './command-key';

describe('commandKeyFromAlways', () => {
  it.each([
    ['git push *', 'git push'],
    ['ls *', 'ls'],
    ['ls', 'ls'],
    ['*', '*'],
    ['  npm run *  ', 'npm run'],
  ])('%j becomes %j', (always, expected) => {
    expect(commandKeyFromAlways(always)).toBe(expected);
  });
});
