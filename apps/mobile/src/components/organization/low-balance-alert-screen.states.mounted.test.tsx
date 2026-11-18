// The low balance alert screen's states: the organization boundary, a failed
// read and a role that may only look, none of which depend on the save form.
import {
  boundary,
  mountScreen,
  query,
  resetLowBalanceState,
} from '@/components/organization/low-balance-alert-screen.test-helpers';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

beforeEach(() => {
  resetLowBalanceState();
});

describe('low balance alert screen states', () => {
  it('keeps a missing organization on the boundary with a header', async () => {
    boundary.organizationId = null;
    boundary.org = null;
    const { renderer, unmount } = await mountScreen();
    const boundaryNode = renderer.root.find(node => String(node.type) === 'OrganizationBoundary');
    expect(boundaryNode.props.title).toBe(i18n.t('organization.lowBalanceAlert.title'));
    unmount();
  });

  it('keeps a failed read retryable outside the scroller', async () => {
    query.isError = true;
    query.data = undefined;
    const { renderer, unmount } = await mountScreen();
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    (error.props.onRetry as () => void)();
    expect(query.refetch).toHaveBeenCalledOnce();
    unmount();
  });

  it('keeps a refused role on the permission state', async () => {
    boundary.role = 'member';
    const { renderer, unmount } = await mountScreen();
    expect(renderer.root.findAll(node => String(node.type) === 'PermissionDenied')).toHaveLength(1);
    unmount();
  });
});
