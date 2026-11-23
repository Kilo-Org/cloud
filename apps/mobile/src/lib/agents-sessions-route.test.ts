import { describe, expect, it } from 'vitest';

import { agentsSessionsExit } from './agents-sessions-route';

describe('agentsSessionsExit', () => {
  it('dismisses back to the tabs route while the sessions route is beneath', () => {
    expect(agentsSessionsExit({ currentIndex: 1 })).toBe('dismiss');
    expect(agentsSessionsExit({ currentIndex: 3 })).toBe('dismiss');
  });

  it('takes the screen’s place when it is its stack’s only route', () => {
    expect(agentsSessionsExit({ currentIndex: 0 })).toBe('replace');
  });
});
