import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { sendPushNotificationsAsync, chunkPushNotifications, isExpoPushToken } = vi.hoisted(() => ({
  sendPushNotificationsAsync: vi.fn(),
  chunkPushNotifications: vi.fn((messages: unknown[]) => [messages]),
  isExpoPushToken: vi.fn((token: string) => token.startsWith('ExponentPushToken[')),
}));

vi.mock('expo-server-sdk', () => ({
  Expo: Object.assign(
    vi.fn().mockImplementation(function ExpoMock(this: unknown) {
      Object.assign(this as object, { chunkPushNotifications, sendPushNotificationsAsync });
    }),
    { isExpoPushToken },
  ),
}));

import { dispatchPushForNewMessage } from './dispatch';

function makeDb(tokenRows: { expo_push_token: string }[], unreadCount = 1) {
  const from = (table: string) => {
    if (table === 'conversations') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { unread_count: unreadCount }, error: null }),
          }),
        }),
      };
    }
    return {
      select: () => ({
        eq: () => Promise.resolve({ data: tokenRows, error: null }),
      }),
    };
  };
  return { from } as unknown as SupabaseClient;
}

const baseArgs = {
  accountId: 'acct-1',
  senderName: 'Ahsan',
  previewText: 'Hello there',
  conversationId: 'conv-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  chunkPushNotifications.mockImplementation((messages: unknown[]) => [messages]);
  isExpoPushToken.mockImplementation((token: string) => token.startsWith('ExponentPushToken['));
  sendPushNotificationsAsync.mockResolvedValue([{ status: 'ok' }]);
});

describe('dispatchPushForNewMessage', () => {
  it('does nothing when the account has no registered devices', async () => {
    await dispatchPushForNewMessage(makeDb([]), baseArgs);
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('skips malformed tokens without sending', async () => {
    await dispatchPushForNewMessage(makeDb([{ expo_push_token: 'not-a-real-token' }]), baseArgs);
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('sends a push with title/body/data for each valid token', async () => {
    await dispatchPushForNewMessage(
      makeDb([{ expo_push_token: 'ExponentPushToken[abc]' }]),
      baseArgs,
    );
    expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    const [messages] = sendPushNotificationsAsync.mock.calls[0];
    expect(messages).toEqual([
      {
        to: 'ExponentPushToken[abc]',
        sound: 'default',
        title: 'Ahsan',
        body: 'Hello there',
        data: { conversationId: 'conv-1' },
        tag: 'conv-1',
        collapseId: 'conv-1',
      },
    ]);
  });

  it('truncates a long preview to keep notifications glanceable', async () => {
    const longText = 'x'.repeat(200);
    await dispatchPushForNewMessage(makeDb([{ expo_push_token: 'ExponentPushToken[abc]' }]), {
      ...baseArgs,
      previewText: longText,
    });
    const [messages] = sendPushNotificationsAsync.mock.calls[0];
    expect(messages[0].body.length).toBeLessThan(longText.length);
    expect(messages[0].body.endsWith('…')).toBe(true);
  });

  it('groups under one notification with a count when the conversation has multiple unread messages', async () => {
    await dispatchPushForNewMessage(
      makeDb([{ expo_push_token: 'ExponentPushToken[abc]' }], 3),
      baseArgs,
    );
    const [messages] = sendPushNotificationsAsync.mock.calls[0];
    expect(messages[0].body).toBe('3 new messages · Hello there');
    expect(messages[0].tag).toBe('conv-1');
    expect(messages[0].collapseId).toBe('conv-1');
  });

  it('never throws even if the DB query fails', async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(dispatchPushForNewMessage(db, baseArgs)).resolves.toBeUndefined();
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('never throws even if Expo delivery itself throws', async () => {
    sendPushNotificationsAsync.mockRejectedValue(new Error('network down'));
    await expect(
      dispatchPushForNewMessage(makeDb([{ expo_push_token: 'ExponentPushToken[abc]' }]), baseArgs),
    ).resolves.toBeUndefined();
  });
});
