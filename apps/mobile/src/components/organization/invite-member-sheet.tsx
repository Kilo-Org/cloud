import { useFocusEffect } from 'expo-router';
import { Check } from '@/components/ui/icons';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Pressable, View } from 'react-native';

import { roleLabel } from '@/components/organization/member-row';
import { getInviteSuccessMessage } from '@/components/organization/invited-member-row-state';
import {
  inviteEmailError,
  inviteErrorCopy,
} from '@/components/organization/invite-member-validators';
import { invitableRoles, submittedInviteRole } from '@/components/organization/invite-member-roles';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { SheetHeader } from '@/components/sheet-header';
import { SheetScrollView } from '@/components/tab-screen';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { captureEvent, ORGANIZATION_MEMBER_INVITED_EVENT } from '@/lib/analytics/posthog';
import { useOrganizationMutations } from '@/lib/hooks/use-organization-mutations';
import { isMoneyRole, type OrgRole, useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { cn } from '@/lib/utils';

export function InviteMemberSheet() {
  const popOnce = usePopOnce();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { organizationId, role: myRole, org, isResolving } = useOrgBoundary();
  const mutations = useOrganizationMutations(organizationId ?? '');
  const emailRef = useRef('');
  const [canSubmit, setCanSubmit] = useState(false);
  const isBillingManager = myRole === 'billing_manager';
  const [role, setRole] = useState<OrgRole>('member');
  // What the caller may assign now; a role that left the list is not submitted.
  const roles = invitableRoles(myRole);
  const selectedRole = submittedInviteRole(myRole, role);
  const openedOnceRef = useRef(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const resetInvite = mutations.invite.reset;
  // A rejected invite is rendered in localized copy, never as the server wrote
  // it: a schema rejection is a JSON issue array (internal code, raw pattern,
  // English message), not a sentence. Correcting the address drops the
  // rejection, so the field never sits under a stale one.
  const inviteError = mutations.invite.isError ? inviteErrorCopy(mutations.invite.error) : null;
  const clearInviteError = () => {
    if (mutations.invite.isError) {
      resetInvite();
    }
  };
  // A reset would drop an in-flight invite's callbacks (its success toast and
  // the members invalidation), so a reopen keeps observing one that is still
  // running. Its outcome belongs to the previous open, so the error is only
  // rendered for a submit made in the form that is open now.
  const invitePendingRef = useRef(false);
  invitePendingRef.current = mutations.invite.isPending;
  const submittedThisOpenRef = useRef(false);
  const visibleInviteError = submittedThisOpenRef.current ? inviteError : null;

  // The route can stay mounted while its sheet is dismissed and presented
  // again, so mount-time state is not a clean slate. Every later focus starts
  // the form over: no text, no derived canSubmit, default role, a field
  // instance without blur-validation, and no mutation error from the last
  // open. The first focus of a fresh mount is already clean, so it is skipped
  // rather than remounting the auto-focused field.
  useFocusEffect(
    useCallback(() => {
      if (!openedOnceRef.current) {
        openedOnceRef.current = true;
        return;
      }
      emailRef.current = '';
      setCanSubmit(false);
      setRole('member');
      setFormEpoch(epoch => epoch + 1);
      submittedThisOpenRef.current = false;
      if (!invitePendingRef.current) {
        resetInvite();
      }
    }, [resetInvite])
  );

  const { requestClose, dialog } = useSheetDismissGuard({
    isDirty: () => emailRef.current.trim().length > 0 || selectedRole !== 'member',
    // One pop per dismissal: a discard can race the invite's own success, and
    // the second `router.back()` would take the members screen with it.
    onDiscard: popOnce,
  });
  // The screen is a native formSheet whose swipe is off, so Android Back is the
  // one dismissal the platform still offers; it asks the same question. Scoped
  // to focus, so a screen pushed above keeps its own Back.
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        // A submitted invite owns the sheet until it answers: the header's
        // controls are disabled for the same window, and dismissing here would
        // leave a created invite with no confirmation and no way to correct it.
        if (invitePendingRef.current) {
          return true;
        }
        requestCloseRef.current();
        return true;
      });
      return () => {
        subscription.remove();
      };
    }, [])
  );

  if (isResolving) {
    return (
      <SheetScrollView
        className="flex-1 bg-background"
        contentContainerClassName="px-6 gap-6 pb-8 pt-4"
      >
        <Skeleton className="h-11 rounded-lg" />
        <Skeleton className="h-11 rounded-lg" />
      </SheetScrollView>
    );
  }
  if (organizationId == null || org == null) {
    return <OrganizationBoundary />;
  }
  if (!isMoneyRole(myRole)) {
    return <PermissionDenied description={t('organization.inviteMember.permissionDenied')} />;
  }

  const onSubmit = () => {
    if (!canSubmit) {
      return;
    }
    const email = emailRef.current.trim().toLowerCase();
    submittedThisOpenRef.current = true;
    mutations.invite.mutate(
      { email, role: selectedRole },
      {
        onSuccess: () => {
          captureEvent(ORGANIZATION_MEMBER_INVITED_EVENT, { role: selectedRole });
          announcingToast.success(getInviteSuccessMessage());
          // The user can leave first (a Back the write outlived, the discard
          // guard), so the success dismisses this route at most once.
          popOnce();
        },
      }
    );
  };

  return (
    <>
      <SheetHeader
        title={t('organization.inviteMember.title')}
        onDone={onSubmit}
        doneLabel={t('organization.inviteMember.sendInvite')}
        onCancel={requestClose}
        disabled={mutations.invite.isPending}
        doneDisabled={!canSubmit || mutations.invite.isPending}
        topInset="bottom-form-sheet"
      />
      <SheetScrollView
        className="flex-1 bg-background"
        contentContainerClassName="px-6 gap-6 pb-8 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <FormField
          key={formEpoch}
          label={t('common.email')}
          required
          placeholder={t('organization.inviteMember.emailPlaceholder')}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          autoFocus
          validate={inviteEmailError}
          error={visibleInviteError?.field === 'email' ? visibleInviteError.message : undefined}
          onChangeText={value => {
            emailRef.current = value;
            setCanSubmit(inviteEmailError(value) == null);
            clearInviteError();
          }}
        />

        {/* The rejected invite sits under the field it names, above the
            software keyboard. The mutation has no toast (inline error pattern
            P2), so AccessibleStatus is the single announcement owner here: one
            announcement per platform, visuals preserved (tone error). */}
        <AccessibleStatus
          message={visibleInviteError?.field === 'form' ? visibleInviteError.message : null}
          className="text-sm"
        />

        {isBillingManager ? (
          <Text variant="muted">{t('organization.inviteMember.roleMember')}</Text>
        ) : (
          <View className="gap-2">
            <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
              {t('common.role')}
            </Text>
            <RadioGroup
              label={t('common.role')}
              className="overflow-hidden rounded-lg bg-secondary"
            >
              {roles.map((value, index) => {
                const selected = selectedRole === value;
                return (
                  <Pressable
                    key={value}
                    className={cn(
                      ROW_TARGET_CLASS,
                      'flex-row items-center justify-between px-4 py-3 active:opacity-70',
                      index < roles.length - 1 && 'border-b-[0.5px] border-hair-soft'
                    )}
                    onPress={() => {
                      setRole(value);
                    }}
                    {...radioItemA11y({ label: roleLabel(value), checked: selected })}
                  >
                    <Text className="flex-1 text-sm">{roleLabel(value)}</Text>
                    {selected && <Check size={16} color={colors.primary} />}
                  </Pressable>
                );
              })}
            </RadioGroup>
          </View>
        )}
      </SheetScrollView>
      {dialog}
    </>
  );
}
