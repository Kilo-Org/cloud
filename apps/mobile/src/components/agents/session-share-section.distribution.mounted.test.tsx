import { describe, expect, it } from 'vitest';

import { holder } from './session-share-section.test-helpers';
import {
  beginShare,
  confirmRevoke,
  deferIdentityRead,
  failShare,
  findByTestID,
  findOne,
  finishShare,
  pressAction,
  rejectIdentityRead,
  renderCreatedLink,
  renderSection,
  rerenderSection,
  resolveIdentityRead,
  setReadState,
  textContent,
  unmountSection,
} from './session-share-section.test-utils';

describe('SessionShareSection pending distribution', () => {
  it('runs one read and shows the running action while repeated presses wait', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-copy'));
    pressAction(findOne(renderer, 'session-share-url'));
    pressAction(findOne(renderer, 'session-share-sheet'));

    expect(holder.refetchCalls).toHaveLength(1);
    expect(findOne(renderer, 'session-share-copy').props.loading).toBe(true);
    expect(findOne(renderer, 'session-share-copy').props.disabled).toBe(true);
    expect(findOne(renderer, 'session-share-sheet').props.disabled).toBe(true);
    expect(findOne(renderer, 'session-share-url').props.disabled).toBe(true);
    expect(findOne(renderer, 'session-share-revoke').props.disabled).toBe(true);

    await resolveIdentityRead(read, { isError: false, data: { public_id: 'share_1' } });

    expect(holder.clipboardWrites).toEqual(['http://localhost:3000/s/tok_1']);
    expect(holder.shares).toEqual([]);
    expect(findOne(renderer, 'session-share-copy').props.loading).toBe(false);
    expect(findOne(renderer, 'session-share-copy').props.disabled).toBe(false);
  });

  it('offers the read again and no URL when the press-time read rejects', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-copy'));
    await rejectIdentityRead(read);

    expect(holder.clipboardWrites).toEqual([]);
    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
    expect(findByTestID(renderer.root, 'session-share-state-error')).toHaveLength(1);
    expect(findByTestID(renderer.root, 'session-share-state-retry')).toHaveLength(1);
  });
});

describe('SessionShareSection presentation ownership', () => {
  it('does not copy after the sheet closes while the read runs', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-copy'));
    rerenderSection(renderer, false);
    await resolveIdentityRead(read, { isError: false, data: { public_id: 'share_1' } });

    expect(holder.clipboardWrites).toEqual([]);
  });

  it('does not open the system share sheet after the sheet closes while the read runs', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-sheet'));
    rerenderSection(renderer, false);
    await resolveIdentityRead(read, { isError: false, data: { public_id: 'share_1' } });

    expect(holder.shares).toEqual([]);
  });

  it('does not copy after the section unmounts while the read runs', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-copy'));
    unmountSection(renderer);
    await resolveIdentityRead(read, { isError: false, data: { public_id: 'share_1' } });

    expect(holder.clipboardWrites).toEqual([]);
  });

  it('does not copy after the session changes while the read runs', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-copy'));
    rerenderSection(renderer, true, 'ses-456');
    await resolveIdentityRead(read, { isError: false, data: { public_id: 'share_1' } });

    expect(holder.clipboardWrites).toEqual([]);
  });

  it('does not copy after a replacement publishes a new link mid-read', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-copy'));
    beginShare();
    await finishShare({ share_token: 'tok_2', public_id: 'share_2' });
    await resolveIdentityRead(read, { isError: false, data: { public_id: 'share_1' } });

    expect(holder.clipboardWrites).toEqual([]);
    expect(textContent(renderer.root)).toContain('http://localhost:3000/s/tok_2');
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(0);
  });

  it('does not apply a late read to a link created after a reopen', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-copy'));
    rerenderSection(renderer, false);
    rerenderSection(renderer, true);
    // A new create after the reopen captures the new presentation.
    pressAction(findOne(renderer, 'session-share-rotate'));
    await finishShare({ share_token: 'tok_2', public_id: 'share_2' });
    await resolveIdentityRead(read, { isError: false, data: { public_id: 'share_3' } });

    expect(holder.clipboardWrites).toEqual([]);
    expect(textContent(renderer.root)).toContain('http://localhost:3000/s/tok_2');
    expect(findByTestID(renderer.root, 'session-share-superseded')).toHaveLength(0);
  });

  it('does not copy after Revoke is confirmed mid-read', async () => {
    const renderer = await renderCreatedLink();
    const read = deferIdentityRead();
    rerenderSection(renderer);

    pressAction(findOne(renderer, 'session-share-copy'));
    pressAction(findOne(renderer, 'session-share-revoke'));
    confirmRevoke();
    await resolveIdentityRead(read, { isError: false, data: { public_id: 'share_1' } });

    expect(holder.clipboardWrites).toEqual([]);
    expect(holder.lastUnshareInput).toEqual({ session_id: 'ses-123' });
  });

  it('does not publish a create that finishes after the sheet closes', async () => {
    setReadState({ data: { public_id: 'share_1' }, isPending: false, dataUpdatedAt: 1 });
    const renderer = renderSection();
    pressAction(findOne(renderer, 'session-share-rotate'));
    rerenderSection(renderer, false);
    await finishShare({ share_token: 'tok_1', public_id: 'share_1' });
    rerenderSection(renderer, true);

    expect(findByTestID(renderer.root, 'session-share-url')).toHaveLength(0);
  });

  it('does not show a create failure that lands after the sheet closes', () => {
    setReadState({ data: { public_id: 'share_1' }, isPending: false, dataUpdatedAt: 1 });
    const renderer = renderSection();
    pressAction(findOne(renderer, 'session-share-rotate'));
    rerenderSection(renderer, false);
    failShare(new Error('boom'));
    rerenderSection(renderer, true);

    expect(findByTestID(renderer.root, 'session-share-error')).toHaveLength(0);
  });
});
