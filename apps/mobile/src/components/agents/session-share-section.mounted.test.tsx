import { act } from '@/test/renderer';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { holder } from './session-share-section.test-helpers';
import {
  findByTestID,
  findOne,
  pressAction,
  pressAndSettle,
  renderCreatedLink,
  renderSection,
  rerenderSection,
  setReadState,
  textContent,
} from './session-share-section.test-utils';

describe('SessionShareSection state gates', () => {
  it('shows a loading row and no create action while the session row is pending', () => {
    const renderer = renderSection();

    expect(findByTestID(renderer.root, 'session-share-state-loading')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(0);
  });

  it('offers the read again instead of create when the session row failed', () => {
    setReadState({ isPending: false, isError: true });
    const renderer = renderSection();

    expect(findByTestID(renderer.root, 'session-share-state-error')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-state-retry')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(0);
  });

  it('shows the create form only once the read reports no live link', () => {
    setReadState({ data: { public_id: null }, isPending: false, dataUpdatedAt: 1 });
    const renderer = renderSection();

    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-state-loading')).toHaveLength(0);
  });

  it('shows the existing-link state with the controls a replacement uses', () => {
    setReadState({ data: { public_id: 'share_1' }, isPending: false, dataUpdatedAt: 1 });
    const renderer = renderSection();

    expect(findByTestID(renderer.root, 'session-share-existing')).toHaveLength(1);
    expect(textContent(renderer.root)).toContain(i18n.t('sessionShare.existingTitle'));
    // The replacement takes the person's choice, so the duration and scope
    // controls stay on screen beside the replace action.
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'SegmentedControl'
      )
    ).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-include-new')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-rotate')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-revoke')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(0);
  });

  it('replaces the existing link with the chosen duration and scope', () => {
    setReadState({ data: { public_id: 'share_1' }, isPending: false, dataUpdatedAt: 1 });
    const renderer = renderSection();

    const duration = renderer.root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'SegmentedControl'
    )[0];
    if (!duration) {
      throw new Error('missing duration control');
    }
    act(() => {
      (duration.props.onChange as (value: string) => void)('1d');
    });
    act(() => {
      (
        findOne(renderer, 'session-share-include-new').props.onValueChange as (
          value: boolean
        ) => void
      )(true);
    });
    pressAction(findOne(renderer, 'session-share-rotate'));

    expect(holder.lastShareInput).toEqual({
      session_id: 'ses-123',
      duration: '1d',
      include_new_messages: true,
    });
  });

  it('settles the session read even while the device reports offline', () => {
    renderSection();

    expect(holder.queryOptions).toMatchObject({
      enabled: true,
      networkMode: 'always',
      refetchOnReconnect: true,
    });
  });
});

describe('SessionShareSection created link', () => {
  it('shows the created link once the share mutation succeeds', async () => {
    const renderer = await renderCreatedLink();

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
    expect(textContent(renderer.root)).toContain('http://localhost:3000/s/tok_1');
  });

  it.each(['session-share-copy', 'session-share-sheet'])(
    'keeps the created URL after a failed refresh, but validates %s at press time',
    async action => {
      const renderer = await renderCreatedLink();
      setReadState({
        data: undefined,
        isPending: false,
        isError: true,
        isFetching: false,
        dataUpdatedAt: Date.now() + 1_000,
      });
      rerenderSection(renderer);

      expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
      expect(findByTestID(renderer.root, 'session-share-state-error')).toHaveLength(0);
      holder.refetchResult = { isError: true, data: undefined };
      await pressAndSettle(findOne(renderer, action));

      expect(holder.refetchCalls).toEqual([{ cancelRefetch: true }]);
      expect(holder.clipboardWrites).toEqual([]);
      expect(holder.shares).toEqual([]);
      expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
      expect(findByTestID(renderer.root, 'session-share-state-error')).toHaveLength(1);
      expect(findByTestID(renderer.root, 'session-share-state-retry')).toHaveLength(1);
    }
  );

  it('keeps offering the link while a later read names the same capability', async () => {
    const renderer = await renderCreatedLink();

    // A read taken after the create that names the same capability: still live.
    setReadState({ data: { public_id: 'share_1' }, dataUpdatedAt: Date.now() + 1_000 });
    rerenderSection(renderer);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(0);
  });

  it('keeps the link when an older web server answers without a capability', async () => {
    /* A web server older than the create response's capability field answers
       with the token alone. There is nothing to compare, so the link must not
       look replaced once the read reports the identity the worker wrote. */
    const renderer = await renderCreatedLink({ share_token: 'tok_1' });

    setReadState({ data: { public_id: 'share_1' }, dataUpdatedAt: Date.now() + 1_000 });
    rerenderSection(renderer);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(0);
  });

  it('stops offering Copy for the URL this sheet made when a read names another capability', async () => {
    /* Rotating the link from another device writes a fresh capability, so the
       URL this sheet holds is revoked while it still looks live here. Comparing
       identities is what tells that from the link still being the live one. */
    const renderer = await renderCreatedLink();

    setReadState({ data: { public_id: 'share_2' }, dataUpdatedAt: Date.now() + 1_000 });
    rerenderSection(renderer);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-rotate')).toHaveLength(1);
    // The current link can still be ended, and its confirmation says it is the
    // current one.
    expect(findByTestID(renderer.root, 'session-share-revoke')).toHaveLength(1);
  });

  it('shows the replaced line when a later read reports no link at all', async () => {
    const renderer = await renderCreatedLink();

    // A read that started after the create, answering that no link exists: the
    // link expired, was revoked, or was rotated out elsewhere.
    setReadState({ data: { public_id: null }, dataUpdatedAt: Date.now() + 1_000 });
    rerenderSection(renderer);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-create')).toHaveLength(0);
  });

  it('drops the link when the sheet closes', async () => {
    const renderer = await renderCreatedLink();

    rerenderSection(renderer, false);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
  });

  it('withholds Copy when a press-time read names another capability', async () => {
    /* The sheet stays open on one device while another rotates the link. The
       cached row still names the old capability, so only a read taken at the
       press can tell that Copy would hand out a dead URL. */
    const renderer = await renderCreatedLink();
    holder.refetchResult = { isError: false, data: { public_id: 'share_2' } };

    await pressAndSettle(findOne(renderer, 'session-share-copy'));

    expect(holder.clipboardWrites).toEqual([]);
    expect(holder.refetchCalls).toEqual([{ cancelRefetch: true }]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
  });

  it('withholds the system share sheet when a press-time read names another capability', async () => {
    const renderer = await renderCreatedLink();
    holder.refetchResult = { isError: false, data: { public_id: 'share_2' } };

    await pressAndSettle(findOne(renderer, 'session-share-sheet'));

    expect(holder.shares).toEqual([]);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
  });

  it('restarts an identity read already in flight before Copy', async () => {
    const renderer = await renderCreatedLink();
    setReadState({
      isFetching: true,
      refetch: async options => {
        holder.refetchCalls.push(options);
        await Promise.resolve();
        return {
          isError: false,
          data: { public_id: options?.cancelRefetch ? 'share_2' : 'share_1' },
        };
      },
    });
    rerenderSection(renderer);

    await pressAndSettle(findOne(renderer, 'session-share-copy'));

    expect(holder.clipboardWrites).toEqual([]);
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(1);
  });

  it('blocks distribution and offers the read again when the press-time read fails', async () => {
    const renderer = await renderCreatedLink();
    holder.refetchResult = { isError: true, data: undefined };

    await pressAndSettle(findOne(renderer, 'session-share-copy'));

    expect(holder.clipboardWrites).toEqual([]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-state-error')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-state-retry')).toHaveLength(1);
  });

  it('hands the URL to Copy and Share when the press-time read names the same capability', async () => {
    const renderer = await renderCreatedLink();

    await pressAndSettle(findOne(renderer, 'session-share-copy'));
    expect(holder.clipboardWrites).toEqual(['http://localhost:3000/s/tok_1']);
    expect(holder.refetchCalls).toEqual([{ cancelRefetch: true }]);

    await pressAndSettle(findOne(renderer, 'session-share-sheet'));
    expect(holder.shares).toEqual([
      { message: 'http://localhost:3000/s/tok_1', url: 'http://localhost:3000/s/tok_1' },
    ]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
  });

  it('distributes a link created without an identity without comparing it', async () => {
    /* A web server older than the create response's capability field leaves
       nothing to compare, so Copy must not be blocked by a read that would
       otherwise look like a replacement. */
    const renderer = await renderCreatedLink({ share_token: 'tok_1' });
    holder.refetchResult = { isError: false, data: { public_id: 'share_2' } };

    await pressAndSettle(findOne(renderer, 'session-share-copy'));

    expect(holder.clipboardWrites).toEqual(['http://localhost:3000/s/tok_1']);
    expect(holder.refetchCalls).toEqual([]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(1);
  });
});
