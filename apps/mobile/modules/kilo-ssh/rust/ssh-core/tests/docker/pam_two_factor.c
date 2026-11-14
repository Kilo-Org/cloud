// Test fixture only: fixed credentials, reachable from the test runner alone.
//
// sshd on Debian asks PAM for authentication; this module turns one PAM
// authentication into two SSH keyboard-interactive prompts so the client's
// multi-round prompt loop is exercised against a real OpenSSH server.
#include <security/pam_ext.h>
#include <security/pam_modules.h>
#include <stdlib.h>
#include <string.h>

#define EXPECTED_CODE "424242"
#define EXPECTED_PASSWORD "ssh-core-password"

static int ask(pam_handle_t *pamh, int style, const char *text, const char *expected) {
  char *answer = NULL;

  if (pam_prompt(pamh, style, &answer, "%s", text) != PAM_SUCCESS) {
    return 0;
  }

  int matches = answer != NULL && strcmp(answer, expected) == 0;
  free(answer);
  return matches;
}

PAM_EXTERN int pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc,
                                   const char **argv) {
  (void)flags;
  (void)argc;
  (void)argv;

  int code_ok = ask(pamh, PAM_PROMPT_ECHO_ON, "Verification code: ", EXPECTED_CODE);
  int password_ok = ask(pamh, PAM_PROMPT_ECHO_OFF, "Password: ", EXPECTED_PASSWORD);

  return code_ok && password_ok ? PAM_SUCCESS : PAM_AUTH_ERR;
}

PAM_EXTERN int pam_sm_setcred(pam_handle_t *pamh, int flags, int argc,
                              const char **argv) {
  (void)pamh;
  (void)flags;
  (void)argc;
  (void)argv;
  return PAM_SUCCESS;
}

PAM_EXTERN int pam_sm_acct_mgmt(pam_handle_t *pamh, int flags, int argc,
                                const char **argv) {
  (void)pamh;
  (void)flags;
  (void)argc;
  (void)argv;
  return PAM_SUCCESS;
}
