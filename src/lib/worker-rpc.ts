export type WorkerRequest = { id: number; method: string; args: unknown[] };
export type WorkerReply = { id: number; value?: unknown; error?: string };
interface Endpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  terminate(): void;
}

// Bounded RPC with a separate notification path for cancellation. The bridge is
// private to this app's dedicated worker, never window.postMessage or a public API.
export class WorkerRPC {
  private next = 0;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  constructor(
    private worker: Endpoint,
    private event: (event: any) => void,
    private failed: (error: Error) => void,
  ) {
    worker.addEventListener("message", ({ data }) => {
      if (this.closed) return;
      if (!data || typeof data.id !== "number") {
        event(data);
        return;
      }
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
    });
    worker.addEventListener("error", () =>
      this.stop(
        new Error(
          "Transfer engine stopped. Reload the page and reconnect; partial CLI files may remain.",
        ),
      ),
    );
    worker.addEventListener("messageerror", () =>
      this.stop(
        new Error("Transfer engine message failed. Reload and reconnect."),
      ),
    );
  }
  call<T>(
    method: string,
    args: unknown[] = [],
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new Error("Transfer engine is closed. Reload and reconnect."),
      );
    if (this.pending.size >= 64)
      return Promise.reject(new Error("Too many pending transfer operations."));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, method, args }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, args: unknown[]) {
    if (!this.closed) this.worker.postMessage({ id: 0, method, args });
  }
  stop(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.failed(error);
  }
}
