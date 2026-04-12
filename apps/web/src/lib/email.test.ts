import { sendViaMailgun } from '@/lib/email-mailgun';
import { verifyEmail } from '@/lib/email-neverbounce';
import { renderTemplate, send } from '@/lib/email';

jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_URL: 'https://app.kilo.ai',
}));

jest.mock('@/lib/email-mailgun', () => ({
  sendViaMailgun: jest.fn(),
}));

jest.mock('@/lib/email-neverbounce', () => ({
  verifyEmail: jest.fn(),
}));

const mockSendViaMailgun = jest.mocked(sendViaMailgun);
const mockVerifyEmail = jest.mocked(verifyEmail);
const freeModelName = 'Kilo Auto Free';

describe('clawComplementaryInferenceEnded email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyEmail.mockResolvedValue(true);
    mockSendViaMailgun.mockResolvedValue(true);
  });

  it('renders with all required template variables', () => {
    const html = renderTemplate('clawComplementaryInferenceEnded', {
      claw_url: 'https://app.kilo.ai/claw',
      free_model_name: freeModelName,
      year: '2026',
    });

    expect(html).toContain(freeModelName);
  });

  it('fails before sending when the free model name is missing', async () => {
    await expect(
      send({
        to: 'user@example.com',
        templateName: 'clawComplementaryInferenceEnded',
        templateVars: {
          claw_url: 'https://app.kilo.ai/claw',
        },
      })
    ).rejects.toThrow(
      "Missing template variable 'free_model_name' in email template 'clawComplementaryInferenceEnded'"
    );
    expect(mockSendViaMailgun).not.toHaveBeenCalled();
  });
});
