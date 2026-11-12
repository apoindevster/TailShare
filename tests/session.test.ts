import { describe, expect, it, vi } from "vitest";
import { File } from "node:buffer";
import { unzipSync, strFromU8 } from "fflate";
import { createShare } from "../src/lib/model";
import { ShareClient, ShareHost, type Sink } from "../src/lib/session";
import { memorySink, downloadZip } from "../src/lib/download";
import { Wire, MAX_JSON, CHUNK } from "../src/lib/wire";
import { connectionPair, memoryTransport } from "./helpers";
const file = (name: string, data: string | Uint8Array) =>
  new File([typeof data === "string" ? data : Buffer.from(data)], name, {
    lastModified: 1,
  }) as unknown as globalThis.File;
const capture = () => {
  const bytes: Uint8Array[] = [];
  let closed = false;
  let aborted = false;
  const sink: Sink = {
    async write(b) {
      bytes.push(b);
    },
    async close() {
      closed = true;
    },
    async abort() {
      aborted = true;
      bytes.length = 0;
    },
  };
  return {
    sink,
    bytes,
    get closed() {
      return closed;
    },
    get aborted() {
      return aborted;
    },
  };
};
describe("streaming protocol", () => {
  it("handles arbitrary frame fragmentation and empty files", async () => {
    const transport = memoryTransport();
    const content = new Uint8Array(CHUNK * 3 + 13).fill(73);
    const share = createShare([file("large.bin", content), file("empty", "")]);
    const host = new ShareHost(
      share,
      { minutes: 60, maxUses: null },
      () => {},
      transport,
    );
    const invite = await host.start();
    const client = new ShareClient(transport);
    try {
      const manifest = await client.connect(invite);
      for (const e of manifest.entries) {
        const out = capture();
        await client.receive(e, out.sink);
        expect(out.closed).toBe(true);
        expect(Buffer.concat(out.bytes)).toEqual(
          Buffer.from(e.size ? content : new Uint8Array()),
        );
      }
    } finally {
      host.stop();
      client.close();
    }
  });
  it("never sends metadata to an unauthenticated recipient", async () => {
    const transport = memoryTransport();
    const host = new ShareHost(
      createShare([file("private.txt", "secret")]),
      { minutes: 60, maxUses: null },
      () => {},
      transport,
    );
    const invite = await host.start();
    const client = new ShareClient(transport);
    try {
      await expect(
        client.connect({ ...invite, token: "0".repeat(64) }),
      ).rejects.toThrow();
      expect(client.manifest).toBeUndefined();
    } finally {
      host.stop();
    }
  });
  it("refuses arbitrary file IDs even after authentication", async () => {
    const transport = memoryTransport();
    const host = new ShareHost(
      createShare([file("allowed", "secret")]),
      { minutes: 60, maxUses: null },
      () => {},
      transport,
    );
    const invite = await host.start();
    try {
      const wire = new Wire(await transport.dial(invite.address));
      await wire.sendJSON({ type: "hello", version: 1, token: invite.token });
      await wire.json();
      await wire.sendJSON({ type: "get", id: "../../unselected" });
      await expect(wire.json()).rejects.toThrow();
    } finally {
      host.stop();
    }
  });
  it("revokes existing and future connections", async () => {
    const transport = memoryTransport();
    const host = new ShareHost(
      createShare([file("allowed", "secret")]),
      { minutes: 60, maxUses: null },
      () => {},
      transport,
    );
    const invite = await host.start();
    const client = new ShareClient(transport);
    const manifest = await client.connect(invite);
    host.stop();
    const out = capture();
    await expect(
      client.receive(manifest.entries[0], out.sink),
    ).rejects.toThrow();
    expect(out.aborted).toBe(true);
    await expect(new ShareClient(transport).connect(invite)).rejects.toThrow();
  });
  it("rejects oversized frames before reading a payload", async () => {
    const [a, b] = connectionPair();
    const header = new Uint8Array(5);
    header[0] = 1;
    new DataView(header.buffer).setUint32(1, MAX_JSON + 1);
    await a.write(header);
    await expect(new Wire(b).json()).rejects.toThrow(/oversized/);
    a.close();
  });
  it("rejects altered payloads without committing the download", async () => {
    const [server, receiver] = connectionPair();
    const entry = {
      id: "f",
      path: "file.txt",
      kind: "file" as const,
      size: 3,
      modified: 1,
    };
    const transport = { listen: vi.fn(), dial: async () => receiver };
    const client = new ShareClient(transport);
    const peer = new Wire(server);
    const task = (async () => {
      await peer.json();
      await peer.sendJSON({
        type: "manifest",
        version: 1,
        entries: [entry],
        expiresAt: Date.now() + 60000,
      });
      await peer.json();
      await peer.sendJSON({ type: "start", id: "f", size: 3 });
      await peer.send(2, new TextEncoder().encode("bad"));
      await peer.sendJSON({ type: "end", id: "f", sha256: "0".repeat(64) });
    })();
    await client.connect({ address: "anything", token: "anything" });
    const out = capture();
    await expect(client.receive(entry, out.sink)).rejects.toThrow(
      /verification/,
    );
    expect(out.closed).toBe(false);
    expect(out.aborted).toBe(true);
    await task;
  });
  it("creates a verified ZIP preserving paths and empty files", async () => {
    const one = file("notes.txt", "hello");
    Object.defineProperty(one, "webkitRelativePath", {
      value: "folder/notes.txt",
    });
    const transport = memoryTransport();
    const share = createShare([one, file("empty", "")], ["unused"]);
    const host = new ShareHost(
      share,
      { minutes: 60, maxUses: null },
      () => {},
      transport,
    );
    const client = new ShareClient(transport);
    try {
      const m = await client.connect(await host.start());
      const out = capture();
      await downloadZip(client, m.entries, out.sink, () => {});
      const unpacked = unzipSync(Buffer.concat(out.bytes));
      expect(strFromU8(unpacked["folder/notes.txt"])).toBe("hello");
      expect(unpacked["empty"].length).toBe(0);
      expect(unpacked["unused/"].length).toBe(0);
      expect(out.closed).toBe(true);
    } finally {
      client.close();
      host.stop();
    }
  });
  it("enforces memory budgets and aborts without a save", async () => {
    const save = vi.fn();
    const sink = memorySink("file", 2, save);
    await expect(sink.write(new Uint8Array(3))).rejects.toThrow(/limit/);
    await sink.abort();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("failure cleanup", () => {
  it("aborts a chosen destination when download starts after cancellation", async () => {
    const client = new ShareClient(memoryTransport());
    client.close();
    const out = capture();
    await expect(
      client.receive(
        { id: "x", path: "x", kind: "file", size: 0, modified: 0 },
        out.sink,
      ),
    ).rejects.toThrow(/Reconnect/);
    expect(out.aborted).toBe(true);
  });
  it("bounds small control messages before reading their body", async () => {
    const [a, b] = connectionPair();
    const h = new Uint8Array(5);
    h[0] = 1;
    new DataView(h.buffer).setUint32(1, 4097);
    await a.write(h);
    await expect(new Wire(b).json(4096)).rejects.toThrow(/oversized/);
    a.close();
  });
  it("expires an existing share and closes its listener", async () => {
    vi.useFakeTimers();
    const transport = memoryTransport();
    const event = vi.fn();
    const host = new ShareHost(
      createShare([file("x", "test")]),
      { minutes: 1, maxUses: null },
      event,
      transport,
    );
    try {
      const invite = await host.start();
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(transport.dial(invite.address)).rejects.toThrow();
      expect(event).toHaveBeenCalledWith({ type: "expired", reason: "time" });
    } finally {
      host.stop();
      vi.useRealTimers();
    }
  });
  it("rejects data beyond the declared length without committing", async () => {
    const [server, receiver] = connectionPair();
    const e = {
      id: "f",
      path: "f",
      kind: "file" as const,
      size: 1,
      modified: 1,
    };
    const client = new ShareClient({
      listen: vi.fn(),
      dial: async () => receiver,
    });
    const peer = new Wire(server);
    const task = (async () => {
      await peer.json();
      await peer.sendJSON({
        type: "manifest",
        version: 1,
        entries: [e],
        expiresAt: Date.now() + 60000,
      });
      await peer.json();
      await peer.sendJSON({ type: "start", id: "f", size: 1 });
      await peer.send(2, new Uint8Array([1, 2]));
    })();
    await client.connect({ address: "unused", token: "unused" });
    const out = capture();
    await expect(client.receive(e, out.sink)).rejects.toThrow(/length/);
    expect(out.aborted).toBe(true);
    expect(out.closed).toBe(false);
    await task;
  });
});

describe("native disk destinations", () => {
  it("streams a separate-file batch into a fresh directory with relative paths", async () => {
    const { downloadSeparate } = await import("../src/lib/download");
    const files = new Map<string, ReturnType<typeof capture>>();
    const roots: string[] = [];
    const directory = (prefix: string): unknown => ({
      async getDirectoryHandle(name: string) {
        if (!prefix) roots.push(name);
        return directory(prefix + name + "/");
      },
      async getFileHandle(name: string) {
        const out = capture();
        files.set(prefix + name, out);
        return {
          async createWritable() {
            return out.sink;
          },
        };
      },
    });
    const picker = vi.fn(async () => directory(""));
    vi.stubGlobal("window", {
      showSaveFilePicker: () => {},
      showDirectoryPicker: picker,
    });
    const one = file("one.txt", "one");
    Object.defineProperty(one, "webkitRelativePath", {
      value: "notes/one.txt",
    });
    const share = createShare([one, file("two.txt", "two")]);
    const transport = memoryTransport();
    const host = new ShareHost(
      share,
      { minutes: 60, maxUses: null },
      () => {},
      transport,
    );
    const client = new ShareClient(transport);
    try {
      const m = await client.connect(await host.start());
      await downloadSeparate(
        client,
        m.entries.filter((e) => e.kind === "file"),
        () => {},
      );
      expect(picker).toHaveBeenCalledWith({ mode: "readwrite" });
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatch(/^TailShare-[a-f0-9-]+$/);
      expect([...files.keys()]).toContain(roots[0] + "/notes/one.txt");
      for (const out of files.values()) expect(out.closed).toBe(true);
      expect(
        Buffer.concat(files.get(roots[0] + "/notes/one.txt")!.bytes).toString(),
      ).toBe("one");
    } finally {
      host.stop();
      client.close();
      vi.unstubAllGlobals();
    }
  });
  it("does not commit a native writer when integrity checking fails", async () => {
    const { chooseSink } = await import("../src/lib/download");
    const out = capture();
    const picker = vi.fn(async () => ({
      createWritable: async () => out.sink,
    }));
    vi.stubGlobal("window", { showSaveFilePicker: picker });
    try {
      const sink = await chooseSink("example.bin", 2 ** 32);
      expect(sink).toBe(out.sink);
      await sink.write(new Uint8Array([1]));
      await sink.abort();
      expect(out.aborted).toBe(true);
      expect(out.closed).toBe(false);
      expect(picker).toHaveBeenCalledWith({ suggestedName: "example.bin" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("share expiry policies", () => {
  it("keeps a never-expiring invitation valid until stopped", async () => {
    vi.useFakeTimers();
    const transport = memoryTransport();
    const host = new ShareHost(
      createShare([file("x.txt", "still here")]),
      { minutes: null, maxUses: null },
      () => {},
      transport,
    );
    const client = new ShareClient(transport);
    try {
      const invite = await host.start();
      await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60_000);
      const manifest = await client.connect(invite);
      expect(manifest.expiresAt).toBeNull();
      const out = capture();
      await client.receive(manifest.entries[0], out.sink);
      expect(Buffer.concat(out.bytes).toString()).toBe("still here");
      host.stop();
      await expect(
        new ShareClient(transport).connect(invite),
      ).rejects.toThrow();
    } finally {
      host.stop();
      client.close();
      vi.useRealTimers();
    }
  });
  it("does not consume a use on bad authentication and lets the last recipient finish", async () => {
    const transport = memoryTransport();
    const event = vi.fn();
    const host = new ShareHost(
      createShare([file("one", "one"), file("two", "two")]),
      { minutes: null, maxUses: 1 },
      event,
      transport,
    );
    const recipient = new ShareClient(transport);
    try {
      const invite = await host.start();
      await expect(
        new ShareClient(transport).connect({
          ...invite,
          token: "0".repeat(64),
        }),
      ).rejects.toThrow();
      expect(event.mock.calls.filter(([e]) => e.type === "uses")).toHaveLength(
        0,
      );
      const manifest = await recipient.connect(invite);
      await expect(
        new ShareClient(transport).connect(invite),
      ).rejects.toThrow();
      const zip = capture();
      await downloadZip(recipient, manifest.entries, zip.sink, () => {});
      expect(Object.keys(unzipSync(Buffer.concat(zip.bytes)))).toEqual([
        "one",
        "two",
      ]);
      expect(event).toHaveBeenCalledWith({ type: "uses", count: 1, limit: 1 });
      expect(event.mock.calls.filter(([e]) => e.type === "uses")).toHaveLength(
        1,
      );
      await recipient.disconnect();
      await vi.waitFor(() =>
        expect(event).toHaveBeenCalledWith({ type: "expired", reason: "uses" }),
      );
      await expect(transport.dial(invite.address)).rejects.toThrow();
    } finally {
      recipient.close();
      host.stop();
    }
  });
  it("atomically reserves uses for simultaneous authenticated connections", async () => {
    const transport = memoryTransport();
    const host = new ShareHost(
      createShare([file("x", "data")]),
      { minutes: null, maxUses: 2 },
      () => {},
      transport,
    );
    const clients = Array.from({ length: 3 }, () => new ShareClient(transport));
    try {
      const invite = await host.start();
      const results = await Promise.allSettled(
        clients.map((client) => client.connect(invite)),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      clients.forEach((client) => client.close());
      host.stop();
    }
  });
  it("counts reconnections without counting additional file downloads", async () => {
    const transport = memoryTransport();
    const event = vi.fn();
    const host = new ShareHost(
      createShare([file("x", "data")]),
      { minutes: null, maxUses: 2 },
      event,
      transport,
    );
    const first = new ShareClient(transport);
    const second = new ShareClient(transport);
    try {
      const invite = await host.start();
      const manifest = await first.connect(invite);
      await first.receive(manifest.entries[0], capture().sink);
      await first.receive(manifest.entries[0], capture().sink);
      expect(event.mock.calls.filter(([e]) => e.type === "uses")).toHaveLength(
        1,
      );
      first.close();
      await second.connect(invite);
      expect(event).toHaveBeenCalledWith({ type: "uses", count: 2, limit: 2 });
      await expect(
        new ShareClient(transport).connect(invite),
      ).rejects.toThrow();
    } finally {
      first.close();
      second.close();
      host.stop();
    }
  });
  it("enforces deadlines even if a background tab's timeout has not fired", async () => {
    vi.useFakeTimers();
    const transport = memoryTransport();
    const host = new ShareHost(
      createShare([file("x", "data")]),
      { minutes: 1, maxUses: null },
      () => {},
      transport,
    );
    const client = new ShareClient(transport);
    try {
      const invite = await host.start();
      const manifest = await client.connect(invite);
      // Move wall time without running timers, like a suspended browser resuming.
      vi.setSystemTime(host.expiresAt!);
      await expect(
        new ShareClient(transport).connect(invite),
      ).rejects.toThrow();
      const out = capture();
      await expect(
        client.receive(manifest.entries[0], out.sink),
      ).rejects.toThrow();
      expect(out.aborted).toBe(true);
      expect(out.closed).toBe(false);
    } finally {
      client.close();
      host.stop();
      vi.useRealTimers();
    }
  });
  it("discards a transfer that expires before its destination is committed", async () => {
    vi.useFakeTimers();
    const transport = memoryTransport();
    const host = new ShareHost(
      createShare([file("x", new Uint8Array(CHUNK * 2))]),
      { minutes: 1, maxUses: null },
      () => {},
      transport,
    );
    const client = new ShareClient(transport);
    try {
      const manifest = await client.connect(await host.start());
      const out = capture();
      await expect(
        client.receive(manifest.entries[0], {
          ...out.sink,
          async write(bytes) {
            await out.sink.write(bytes);
            vi.setSystemTime(host.expiresAt!);
          },
        }),
      ).rejects.toThrow();
      expect(out.aborted).toBe(true);
      expect(out.closed).toBe(false);
    } finally {
      client.close();
      host.stop();
      vi.useRealTimers();
    }
  });
  it.each([0, -1, 1.5, 1001, NaN, Infinity])(
    "rejects invalid use limit %s",
    (maxUses) => {
      expect(
        () => new ShareHost(createShare([]), { minutes: null, maxUses }),
      ).toThrow(/recipient connections/);
    },
  );
  it.each([0, -1, 0.5, 1441, NaN, Infinity])(
    "rejects invalid time limit %s",
    (minutes) => {
      expect(
        () => new ShareHost(createShare([]), { minutes, maxUses: null }),
      ).toThrow(/expiry/);
    },
  );
});
