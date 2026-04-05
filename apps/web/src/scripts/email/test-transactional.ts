import {
  sendOrgCancelledEmail,
  sendOrgRenewedEmail,
  sendOrgSSOUserJoinedEmail,
  sendOrgSubscriptionEmail,
} from '@/lib/email';
import { assert } from 'node:console';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function run(toAddress: string) {
  console.log('test send to', toAddress);
  assert(toAddress, 'toAddress is required');

  await sendOrgSubscriptionEmail(toAddress, {
    seatCount: 5,
    organizationId: '0e4c8216-9a79-4f25-a196-84bd58dec6ed',
  });

  await wait(1000);

  await sendOrgRenewedEmail(toAddress, {
    seatCount: 5,
    organizationId: '0e4c8216-9a79-4f25-a196-84bd58dec6ed',
  });

  await wait(1000);

  await sendOrgCancelledEmail(toAddress, {
    organizationId: '0e4c8216-9a79-4f25-a196-84bd58dec6ed',
  });

  await wait(1000);

  await sendOrgSSOUserJoinedEmail(toAddress, {
    organizationId: '0e4c8216-9a79-4f25-a196-84bd58dec6ed',
    new_user_email: 'newuser@example.com',
  });
}
