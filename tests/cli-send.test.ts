import { describe, expect, it, vi } from "vitest";
import { CLISender, type CLIUploadTransport } from "../src/lib/cli-send";
import { createShare, type LocalShare } from "../src/lib/model";
import { unzipSync } from "fflate";

const key = "tc" + "a".repeat(100);
function bridge() {
  const writes: Uint8Array[] = [];
  const transport: CLIUploadTransport = {
    start: vi.fn(async () => 1),
    connect: vi.fn(async (_id, _key, data) =>
      JSON.parse(data).mode === "tree" ? "TailShare-" + "a".repeat(32) : "",
    ),
    file: vi.fn(async (_id, op, value) => {
      if (op === "write") writes.push(new Uint8Array(value as Uint8Array));
    }),
    close: vi.fn(),
  };
  return { transport, writes };
}
function selection() {
  const file = new File([new Uint8Array(100_000).fill(42)], "binary.bin");
  Object.defineProperty(file, "webkitRelativePath", {
    value: "folder/binary.bin",
  });
  return createShare([file, new File([], "empty.txt")], ["empty-dir"]);
}
describe("browser to CLI uploads", () => {
  it.each(["flat", "tree"] as const)(
    "streams selected files in %s mode, bounded and acknowledged",
    async (mode) => {
      const { transport, writes } = bridge();
      const share = selection();
      const result = await new CLISender(transport).send(key, share, mode);
      expect(result.files).toBe(2);
      expect(Buffer.concat(writes)).toEqual(Buffer.alloc(100_000, 42));
      expect(writes.every((b) => b.length <= 262144)).toBe(true);
      expect(transport.file).toHaveBeenLastCalledWith(1, "finish");
      expect(transport.close).toHaveBeenCalledOnce();
    },
  );
  it("streams a valid ZIP preserving paths and empty directories", async () => {
    const { transport, writes } = bridge();
    await new CLISender(transport).send(key, selection(), "zip");
    const files = unzipSync(Buffer.concat(writes));
    expect(files["folder/binary.bin"]).toEqual(
      new Uint8Array(100_000).fill(42),
    );
    expect(files["empty.txt"].length).toBe(0);
    expect(files["empty-dir/"]).toBeDefined();
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it("validates files and paths before connecting", async () => {
    for (const modify of [
      (s: LocalShare) => {
        s.entries[0].path = "../escape";
      },
      (s: LocalShare) => {
        s.files.clear();
      },
      (s: LocalShare) => {
        s.entries.find((e) => e.kind === "file")!.size++;
      },
    ]) {
      const { transport } = bridge();
      const share = selection();
      modify(share);
      await expect(
        new CLISender(transport).send(key, share, "flat"),
      ).rejects.toThrow();
      expect(transport.start).not.toHaveBeenCalled();
    }
  });
  it("rejects invitations, commands and URLs as a receiver key", async () => {
    for (const value of [
      `share=${key}&key=${"b".repeat(64)}`,
      `tailcat recv ${key}`,
      `https://example.test/#${key}`,
    ]) {
      const { transport } = bridge();
      await expect(
        new CLISender(transport).send(value, selection(), "flat"),
      ).rejects.toThrow(/receiver key/);
      expect(transport.start).not.toHaveBeenCalled();
    }
  });
  it("cleans up cancellation while WASM is loading without connecting", async () => {
    const { transport } = bridge();
    let done!: (id: number) => void;
    transport.start = () =>
      new Promise((resolve) => {
        done = resolve;
      });
    const sender = new CLISender(transport);
    const pending = sender.send(key, selection(), "flat");
    sender.close();
    done(7);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(transport.close).toHaveBeenCalledWith(7);
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it("stops on a failed write without claiming completion or retrying", async () => {
    const { transport } = bridge();
    transport.file = vi.fn(async (_id, op) => {
      if (op === "write") throw new Error("full inbox");
    });
    await expect(
      new CLISender(transport).send(key, selection(), "flat"),
    ).rejects.toThrow(/full inbox/);
    expect(transport.file).not.toHaveBeenCalledWith(1, "finish");
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it("does not send subsequent files after cancellation", async () => {
    const { transport } = bridge();
    const sender = new CLISender(transport);
    transport.file = vi.fn(async (_id, op) => {
      if (op === "write") sender.close();
    });
    await expect(sender.send(key, selection(), "flat")).rejects.toThrow(
      /cancelled/,
    );
    expect(transport.file).not.toHaveBeenCalledWith(1, "finish");
  });
  it("requires the final receiver acknowledgement", async () => {
    const { transport } = bridge();
    transport.file = vi.fn(async (_id, op) => {
      if (op === "finish") throw new Error("size mismatch");
    });
    await expect(
      new CLISender(transport).send(key, selection(), "flat"),
    ).rejects.toThrow(/size mismatch/);
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it("rejects oversized ZIPs before sending any bytes", async () => {
    const { transport } = bridge();
    const share = selection();
    const e = share.entries.find((e) => e.kind === "file")!;
    e.size = 4_000_000_000;
    share.files.set(e.id, { size: e.size } as File);
    await expect(
      new CLISender(transport).send(key, share, "zip"),
    ).rejects.toThrow(/4 GB/);
    expect(transport.start).not.toHaveBeenCalled();
  });
  it("can send an empty folder tree but will not silently drop it in flat mode", async () => {
    const share = createShare([], ["empty"]);
    const { transport } = bridge();
    await expect(
      new CLISender(transport).send(key, share, "flat"),
    ).rejects.toThrow(/empty folders/);
    expect(transport.start).not.toHaveBeenCalled();
    await new CLISender(transport).send(key, share, "tree");
    expect(transport.file).not.toHaveBeenCalled();
  });
});
