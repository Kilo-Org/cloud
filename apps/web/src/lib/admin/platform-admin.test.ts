import { isEligibleForPlatformAdmin, shouldAutoProvisionPlatformAdmin } from './platform-admin';

describe('isEligibleForPlatformAdmin', () => {
  test.each(['kilocode.ai', 'anaconda.com'])(
    'is eligible for an exact lowercase %s email and hosted domain',
    domain => {
      expect(isEligibleForPlatformAdmin(`person@${domain}`, domain)).toBe(true);
    }
  );

  it('is not eligible when the hosted domain is a personal/provider placeholder', () => {
    expect(isEligibleForPlatformAdmin('person@kilocode.ai', '@@personal@@')).toBe(false);
  });

  it('is not eligible when the hosted domain is null', () => {
    expect(isEligibleForPlatformAdmin('person@kilocode.ai', null)).toBe(false);
  });

  it('is not eligible when the hosted domain matches but the email is not from an allowed domain', () => {
    expect(isEligibleForPlatformAdmin('person@example.com', 'kilocode.ai')).toBe(false);
  });

  it('is not eligible when the email and hosted domain belong to different allowed domains', () => {
    expect(isEligibleForPlatformAdmin('person@anaconda.com', 'kilocode.ai')).toBe(false);
  });

  it('is not eligible for uppercase email variants', () => {
    expect(isEligibleForPlatformAdmin('Person@Kilocode.ai', 'kilocode.ai')).toBe(false);
  });

  it('is not eligible for uppercase hosted domain variants', () => {
    expect(isEligibleForPlatformAdmin('person@kilocode.ai', 'Kilocode.ai')).toBe(false);
  });

  it('is not eligible for a subdomain lookalike', () => {
    expect(isEligibleForPlatformAdmin('person@sub.kilocode.ai', 'kilocode.ai')).toBe(false);
    expect(isEligibleForPlatformAdmin('person@sub.anaconda.com', 'anaconda.com')).toBe(false);
  });

  it('is not eligible for a registrable-parent-domain lookalike', () => {
    expect(isEligibleForPlatformAdmin('person@notkilocode.ai', 'kilocode.ai')).toBe(false);
    expect(isEligibleForPlatformAdmin('person@notanaconda.com', 'anaconda.com')).toBe(false);
  });

  it('is not eligible for a fake-login hosted domain even with a kilocode.ai email', () => {
    expect(isEligibleForPlatformAdmin('person@kilocode.ai', '@@fake@@')).toBe(false);
  });
});

describe('shouldAutoProvisionPlatformAdmin', () => {
  it('auto-provisions a fake-login admin.example.com user when fake login is enabled', () => {
    expect(shouldAutoProvisionPlatformAdmin('someone@admin.example.com', '@@fake@@', true)).toBe(
      true
    );
  });

  it('does not auto-provision when fake login is disabled', () => {
    expect(shouldAutoProvisionPlatformAdmin('someone@admin.example.com', '@@fake@@', false)).toBe(
      false
    );
  });

  it('does not auto-provision when the hosted domain is not the fake-login domain', () => {
    expect(shouldAutoProvisionPlatformAdmin('someone@admin.example.com', null, true)).toBe(false);
  });

  it('does not auto-provision a fake-login user with a non-admin email', () => {
    expect(shouldAutoProvisionPlatformAdmin('someone@example.com', '@@fake@@', true)).toBe(false);
  });

  it('never auto-provisions a real production kilocode.ai user, even when fake login is enabled', () => {
    expect(shouldAutoProvisionPlatformAdmin('person@kilocode.ai', 'kilocode.ai', true)).toBe(false);
  });
});
