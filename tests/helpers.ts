import type { Connection } from "../src/lib/wire";
import type { Transport } from "../src/lib/transport";
import { PORT } from "../src/lib/transport";
export function connectionPair(fragment = 127): [Connection, Connection] {
  const buffers: (Uint8Array | null)[][] = [[], []];
  const waiters: ((v: Uint8Array | null) => void)[][] = [[], []];
  let closed = false;
  const push = (side: number, bytes: Uint8Array | null) => {
    const waiting = waiters[side].shift();
    if (waiting) waiting(bytes);
    else buffers[side].push(bytes);
  };
  const make = (side: number): Connection => ({
    port: PORT,
    read: () =>
      buffers[side].length
        ? Promise.resolve(buffers[side].shift()!)
        : closed
          ? Promise.resolve(null)
          : new Promise((resolve) => waiters[side].push(resolve)),
    write: async (data) => {
      if (closed) throw new Error("closed");
      for (let i = 0; i < data.length; i += fragment)
        push(1 - side, data.slice(i, i + fragment));
    },
    close() {
      if (closed) return;
      closed = true;
      push(0, null);
      push(1, null);
    },
  });
  return [make(0), make(1)];
}
export function memoryTransport(): Transport {
  let incoming: ((c: Connection) => void) | undefined;
  return {
    async listen(callback) {
      incoming = callback;
      return {
        addr: "tc" + "a".repeat(100),
        close() {
          incoming = undefined;
        },
      };
    },
    async dial() {
      if (!incoming) throw new Error("Share closed");
      const [a, b] = connectionPair();
      incoming(a);
      return b;
    },
  };
}
