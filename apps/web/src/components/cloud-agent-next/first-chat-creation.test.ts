import { createFirstChatCreationGuard } from './first-chat-creation';

describe('createFirstChatCreationGuard', () => {
  it('admits only one holder until it is released', () => {
    const guard = createFirstChatCreationGuard();

    expect(guard.tryBegin()).toBe(true);
    expect(guard.tryBegin()).toBe(false);

    guard.end();
    expect(guard.tryBegin()).toBe(true);
  });
});
