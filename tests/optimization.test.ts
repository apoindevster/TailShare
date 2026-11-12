import { afterEach, describe, expect, it, vi } from "vitest";
import { progressReporter } from "../src/lib/progress";
import {
  ScreenAwake,
  type WakeHandle,
  type WakeState,
} from "../src/lib/wake-lock";
import { WorkerRPC } from "../src/lib/worker-rpc";

afterEach(() => vi.useRealTimers());
const entry = {
  id: "file",
  path: "file.bin",
  kind: "file" as const,
  size: 1000,
  modified: 0,
};
describe("progress presentation", () => {
  it("bounds updates without delaying completion or the start of another file", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const reporter = progressReporter(commit);
    for (let bytes = 0; bytes < 500; bytes++)
      reporter.report({ entry, bytes, total: 1000 });
    expect(commit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(commit).toHaveBeenLastCalledWith({ entry, bytes: 499, total: 1000 });
    reporter.report({ entry, bytes: 1000, total: 1000 });
    expect(commit).toHaveBeenLastCalledWith({
      entry,
      bytes: 1000,
      total: 1000,
    });
    reporter.report({ entry: { ...entry, id: "next" }, bytes: 0, total: 1000 });
    expect(commit).toHaveBeenCalledTimes(4);
    reporter.dispose();
  });
  it("never resurrects a cancelled transfer with a stale progress callback", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const reporter = progressReporter(commit);
    reporter.report({ entry, bytes: 0, total: 1000 });
    reporter.report({ entry, bytes: 100, total: 1000 });
    reporter.report(undefined);
    vi.runAllTimers();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith(undefined);
    reporter.report({ entry, bytes: 0, total: 1000 });
    reporter.report({ entry, bytes: 100, total: 1000 });
    reporter.dispose();
    vi.runAllTimers();
    expect(commit).toHaveBeenCalledTimes(3);
  });
});
function handle() {
  let released = () => {};
  const h: WakeHandle = {
    release: vi.fn(async () => released()),
    addEventListener: (_type, listener) => {
      released = listener;
    },
  };
  return { h, systemRelease: () => released() };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
describe("screen wake lock lifecycle", () => {
  it("requests only while opted in, active and visible, releasing on stop", async () => {
    const { h } = handle();
    const request = vi.fn(async () => h);
    const state = vi.fn();
    const lock = new ScreenAwake(request, state);
    lock.update(false, true, true);
    lock.update(true, false, true);
    expect(request).not.toHaveBeenCalled();
    lock.update(true, true, true);
    await settle();
    expect(state).toHaveBeenLastCalledWith("held");
    lock.update(true, false, true);
    expect(h.release).toHaveBeenCalledOnce();
    expect(state).toHaveBeenLastCalledWith("waiting");
  });
  it("releases an acquisition that finishes after cancellation", async () => {
    let done!: (h: WakeHandle) => void;
    const { h } = handle();
    const state = vi.fn();
    const lock = new ScreenAwake(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
      state,
    );
    lock.update(true, true, true);
    lock.dispose();
    done(h);
    await settle();
    expect(h.release).toHaveBeenCalledOnce();
    expect(state).not.toHaveBeenCalledWith("held");
  });
  it("reacquires on return to the page but does not fight a system release", async () => {
    const first = handle(),
      second = handle();
    const request = vi
      .fn()
      .mockResolvedValueOnce(first.h)
      .mockResolvedValueOnce(second.h);
    const state = vi.fn<(state: WakeState) => void>();
    const lock = new ScreenAwake(request, state);
    lock.update(true, true, true);
    await settle();
    first.systemRelease();
    lock.update(true, true, true);
    expect(request).toHaveBeenCalledOnce();
    expect(state).toHaveBeenLastCalledWith("released");
    lock.update(true, true, false);
    lock.update(true, true, true);
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(state).toHaveBeenLastCalledWith("held");
    lock.dispose();
  });
  it("reports unsupported and denied requests without interrupting transfers", async () => {
    const state = vi.fn();
    new ScreenAwake(undefined, state).update(true, true, true);
    expect(state).toHaveBeenLastCalledWith("unsupported");
    const lock = new ScreenAwake(async () => {
      throw new Error("denied");
    }, state);
    lock.update(true, true, true);
    await settle();
    expect(state).toHaveBeenLastCalledWith("unavailable");
    lock.dispose();
  });
});
function endpoint() {
  const listeners = new Map<string, (event: any) => void>();
  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    addEventListener: (type: string, listener: (event: any) => void) => {
      listeners.set(type, listener);
    },
  };
  return {
    worker,
    emit: (type: string, event: any) => listeners.get(type)!(event),
  };
}
describe("worker transfer bridge", () => {
  it("matches out-of-order responses and separates peer events from results", async () => {
    const { worker, emit } = endpoint();
    const event = vi.fn();
    const rpc = new WorkerRPC(worker, event, vi.fn());
    const a = rpc.call("read", [1]),
      b = rpc.call("read", [2]);
    emit("message", { data: { id: 2, value: new Uint8Array([2]) } });
    emit("message", { data: { event: "connection", connection: 3 } });
    emit("message", { data: { id: 1, value: new Uint8Array([1]) } });
    expect(await a).toEqual(new Uint8Array([1]));
    expect(await b).toEqual(new Uint8Array([2]));
    expect(event).toHaveBeenCalledOnce();
  });
  it("rejects pending operations on worker failure instead of hanging", async () => {
    const { worker, emit } = endpoint();
    const failed = vi.fn();
    const rpc = new WorkerRPC(worker, vi.fn(), failed);
    const pending = rpc.call("read").catch((error: Error) => error.message);
    emit("error", {});
    expect(await pending).toContain("stopped");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    await expect(rpc.call("read")).rejects.toThrow(/closed/);
  });
  it("caps pending work while allowing immediate cancellation notifications", async () => {
    const { worker } = endpoint();
    const rpc = new WorkerRPC(worker, vi.fn(), vi.fn());
    const pending = Array.from({ length: 64 }, () =>
      rpc.call("read").catch(() => {}),
    );
    await expect(rpc.call("read")).rejects.toThrow(/Too many/);
    rpc.notify("close", [1]);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      id: 0,
      method: "close",
      args: [1],
    });
    rpc.stop(new Error("done"));
    await Promise.all(pending);
  });
});
