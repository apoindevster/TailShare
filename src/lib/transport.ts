import type { Connection } from "./wire";
import { WorkerRPC } from "./worker-rpc";
export const PORT = 1443;
export const DERP_MAP = "https://tailcat.dev/derpmap.json";
export interface Listener {
  addr: string;
  close(): void;
}
export interface Transport {
  listen(onConnection: (connection: Connection) => void): Promise<Listener>;
  dial(address: string): Promise<Connection>;
}
declare const __TRANSPORT_ASSETS__: { wasm: string; runtime: string };
declare global {
  interface Window {
    tailshareListen(options: {
      derpMapURL: string;
      onConnection: (id: number) => void;
    }): Promise<{ id: number; addr: string }>;
    tailshareDial(options: {
      addr: string;
      derpMapURL: string;
    }): Promise<number>;
    tailshareIO(
      op: string,
      id: number,
      data?: Uint8Array,
    ): Promise<Uint8Array | null>;
    tailshareStop(id: number): void;
  }
}
export type EngineStatus = {
  phase: "idle" | "loading" | "ready" | "error";
  message: string;
};
let status: EngineStatus = { phase: "idle", message: "" };
const observers = new Set<() => void>();
export const engineStatus = () => status;
export function subscribeEngine(observer: () => void) {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}
function update(next: EngineStatus) {
  status = next;
  for (const observer of observers) observer();
}
let loading: Promise<void> | undefined;
export function loadTransport(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    if (!__TRANSPORT_ASSETS__)
      throw new Error(
        "Transport files are missing. Run npm run build:wasm and reload.",
      );
    if (!window.isSecureContext)
      throw new Error(
        "TailShare needs HTTPS or localhost. Open it on a secure address.",
      );
    update({ phase: "loading", message: "Preparing transfer engine" });
    const worker = new Worker(
      new URL("./transport-worker.ts", import.meta.url),
      { type: "module", name: "TailShare transport" },
    );
    const listeners = new Map<number, (id: number) => void>();
    const listenerIDs = new Map<number, number>();
    let listenerToken = 0;
    const rpc = new WorkerRPC(
      worker,
      (event) => {
        if (event?.event === "connection") {
          const callback = listeners.get(event.listener);
          if (callback) callback(event.connection);
          else rpc.notify("tailshareIO", ["close", event.connection]);
        } else if (event?.event === "stage") {
          update({
            phase: event.value === "Ready" ? "ready" : "loading",
            message: event.value,
          });
        } else if (event?.event === "fatal")
          rpc.stop(
            new Error(
              "Transfer engine stopped. Reload and reconnect; partial CLI files may remain.",
            ),
          );
      },
      (error) => {
        listeners.clear();
        listenerIDs.clear();
        loading = undefined;
        update({ phase: "error", message: error.message });
      },
    );
    const timer = setTimeout(
      () =>
        rpc.stop(
          new Error(
            "Transfer engine startup timed out. Check your connection and retry.",
          ),
        ),
      90_000,
    );
    try {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI);
      await rpc.call("initialize", [
        new URL(__TRANSPORT_ASSETS__.wasm, base).href,
        new URL(__TRANSPORT_ASSETS__.runtime, base).href,
      ]);
      window.tailshareListen = async (options) => {
        const token = ++listenerToken;
        listeners.set(token, options.onConnection);
        try {
          const result = await rpc.call<{ id: number; addr: string }>(
            "tailshareListen",
            [{ derpMapURL: options.derpMapURL }, token],
          );
          listenerIDs.set(result.id, token);
          return result;
        } catch (error) {
          listeners.delete(token);
          throw error;
        }
      };
      window.tailshareStop = (id) => {
        const token = listenerIDs.get(id);
        if (token !== undefined) listeners.delete(token);
        listenerIDs.delete(id);
        rpc.notify("tailshareStop", [id]);
      };
      window.tailshareDial = (options) => rpc.call("tailshareDial", [options]);
      window.tailshareIO = (op, id, data) => {
        if (op === "close") {
          rpc.notify("tailshareIO", [op, id]);
          return Promise.resolve(null);
        }
        // Callers retain ownership (ZIP/hash code can still reference this array).
        return rpc.call("tailshareIO", [op, id, data]);
      };
      window.tailshareCLIStart = () => rpc.call("tailshareCLIStart");
      window.tailshareCLIConnect = (id, key, map, plan) =>
        rpc.call("tailshareCLIConnect", [id, key, map, plan]);
      window.tailshareCLIDirectory = (id, op, value) =>
        rpc.call("tailshareCLIDirectory", [id, op, value]);
      window.tailshareCLIFile = (id, op, entry) =>
        rpc.call("tailshareCLIFile", [id, op, entry]);
      window.tailshareCLIUpload = (id, op, value) =>
        rpc.call("tailshareCLIUpload", [id, op, value]);
      window.tailshareCLIClose = (id) => rpc.notify("tailshareCLIClose", [id]);
      update({ phase: "ready", message: "Ready" });
    } catch (error) {
      rpc.stop(
        error instanceof Error
          ? error
          : new Error("Could not start the transfer engine."),
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })().catch((error) => {
    loading = undefined;
    update({
      phase: "error",
      message:
        error instanceof Error
          ? error.message
          : "Could not load the transfer engine.",
    });
    throw error;
  });
  return loading;
}
function wrap(id: number): Connection {
  let closed = false;
  return {
    port: PORT,
    read: () => window.tailshareIO("read", id),
    write: async (data) => {
      await window.tailshareIO("write", id, data);
    },
    close: () => {
      if (!closed) {
        closed = true;
        void window.tailshareIO("close", id);
      }
    },
  };
}
export const tailcat: Transport = {
  async listen(onConnection) {
    await loadTransport();
    const listener = await window.tailshareListen({
      derpMapURL: DERP_MAP,
      onConnection: (id) => onConnection(wrap(id)),
    });
    return {
      addr: listener.addr,
      close: () => window.tailshareStop(listener.id),
    };
  },
  async dial(address) {
    await loadTransport();
    return wrap(
      await window.tailshareDial({ addr: address, derpMapURL: DERP_MAP }),
    );
  },
};
