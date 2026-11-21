import { z } from 'zod';
import type { LoopbackSocketConnect } from './loopback-transport';

/*
 * The one place the loopback transport touches the global WebSocket. Kept apart
 * from `loopback-transport.ts` so the handshake logic is testable without a
 * socket, and so this adapter is the only browser-typed edge.
 */

const textFrameSchema = z.string();

export const connectLoopbackSocket: LoopbackSocketConnect = (url, handlers) => {
  const socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    handlers.onOpen();
  });
  socket.addEventListener('close', () => {
    handlers.onClose();
  });
  socket.addEventListener('error', () => {
    handlers.onError();
  });
  socket.addEventListener('message', event => {
    const text = textFrameSchema.safeParse(event.data);

    if (!text.success) {
      handlers.onError();

      return;
    }

    handlers.onText(text.data);
  });

  return {
    close: () => {
      socket.close();
    },
    sendText: (text: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(text);
      }
    },
  };
};
