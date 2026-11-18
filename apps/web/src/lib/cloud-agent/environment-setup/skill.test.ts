import { ENVIRONMENT_SETUP_SKILL } from './skill';

describe('ENVIRONMENT_SETUP_SKILL', () => {
  it('renders the skill', () => {
    expect(ENVIRONMENT_SETUP_SKILL).toMatchSnapshot();
  });

  it('names the skill environment-setup', () => {
    expect(ENVIRONMENT_SETUP_SKILL.name).toBe('environment-setup');
  });
});
