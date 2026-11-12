import { describe, expect, it, vi } from "vitest";
import { CLIClient, type CLITransport } from "../src/lib/cli";
import { inviteKey, parseReceiveKey, type Entry } from "../src/lib/model";
import { downloadZip } from "../src/lib/download";
import { unzipSync } from "fflate";
import type { Sink } from "../src/lib/session";

const address = "tc" + "a".repeat(100);
const entry: Entry = {
  id: "ZmlsZQ." + "a".repeat(43),
  path: "file.txt",
  kind: "file",
  size: 3,
  modified: 0,
};
function capture() {
  const bytes: Uint8Array[] = [];
  const sink: Sink = {
    write: vi.fn(async (b) => {
      bytes.push(b);
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  return { sink, bytes };
}
function transport(
  entries = [entry],
  chunks: (Uint8Array | null)[] = [new Uint8Array([1, 2, 3]), null],
): CLITransport {
  let offset = 0;
  return {
    start: vi.fn(async () => 1),
    connect: vi.fn(async () =>
      JSON.stringify({ entries, skipped: 0, done: true, cursor: "" }),
    ),
    directory: vi.fn(async () =>
      JSON.stringify({ entries: [], skipped: 0, done: true, cursor: "" }),
    ),
    file: vi.fn(async (_id, op) => {
      if (op === "open") offset = 0;
      return op === "read" ? chunks[offset++] : null;
    }),
    close: vi.fn(),
  };
}

describe("CLI keys", () => {
  it("accepts a bare CLI key in the same field as a browser key", () => {
    expect(parseReceiveKey(` ${address}\n`)).toEqual({ kind: "cli", address });
    const invite = { address, token: "a".repeat(64) };
    expect(parseReceiveKey(inviteKey(invite))).toEqual({
      kind: "browser",
      invite,
    });
  });
  it("never downgrades a damaged browser invitation to CLI authentication", () => {
    for (const key of [
      `share=${address}`,
      `share=${address}&key=invalid`,
      `https://example.test/#share=${address}`,
      address + ":../secret",
      address + "\nfiles",
    ])
      expect(() => parseReceiveKey(key)).toThrow();
  });
});

describe("CLI receiver", () => {
  it("commits a complete SFTP transfer only after the final metadata check", async () => {
    const bridge = transport();
    const client = new CLIClient(bridge);
    await client.connect(address);
    const out = capture();
    await client.receive(entry, out.sink);
    expect(Buffer.concat(out.bytes)).toEqual(Buffer.from([1, 2, 3]));
    expect(bridge.file).toHaveBeenLastCalledWith(1, "finish");
    expect(out.sink.close).toHaveBeenCalledOnce();
    expect(out.sink.abort).not.toHaveBeenCalled();
    await client.disconnect();
    expect(bridge.close).toHaveBeenCalledOnce();
  });
  it("saves zero-byte files", async () => {
    const empty = { ...entry, size: 0 };
    const client = new CLIClient(transport([empty], [null]));
    await client.connect(address);
    const out = capture();
    await client.receive(empty, out.sink);
    expect(out.bytes).toEqual([]);
    expect(out.sink.close).toHaveBeenCalledOnce();
  });
  it.each([
    [new Uint8Array([1]), null],
    [new Uint8Array(4), null],
    [new Uint8Array(), null],
  ])("aborts invalid transfer lengths", async (...chunks) => {
    const client = new CLIClient(transport([entry], chunks));
    await client.connect(address);
    const out = capture();
    await expect(client.receive(entry, out.sink)).rejects.toThrow();
    expect(out.sink.abort).toHaveBeenCalledOnce();
    expect(out.sink.close).not.toHaveBeenCalled();
    expect(client.closed).toBe(true);
  });
  it("discards a file that changed before commit", async () => {
    const bridge = transport();
    const original = bridge.file;
    bridge.file = async (id, op, entryID) => {
      if (op === "finish") throw new Error("File changed");
      return original(id, op, entryID);
    };
    const client = new CLIClient(bridge);
    await client.connect(address);
    const out = capture();
    await expect(client.receive(entry, out.sink)).rejects.toThrow(/changed/);
    expect(out.sink.abort).toHaveBeenCalledOnce();
    expect(out.sink.close).not.toHaveBeenCalled();
  });
  it("rejects unsafe paths and closes the CLI session", async () => {
    const bridge = transport([{ ...entry, path: "../outside" }]);
    const client = new CLIClient(bridge);
    await expect(client.connect(address)).rejects.toThrow();
    expect(bridge.close).toHaveBeenCalledOnce();
  });
  it("refuses unlisted files without asking the CLI to open them", async () => {
    const bridge = transport();
    const client = new CLIClient(bridge);
    await client.connect(address);
    const out = capture();
    await expect(
      client.receive({ ...entry, id: "2" }, out.sink),
    ).rejects.toThrow();
    expect(bridge.file).not.toHaveBeenCalled();
    expect(out.sink.abort).toHaveBeenCalledOnce();
  });
  it("cleans up a session created after cancellation", async () => {
    const bridge = transport();
    let resolve!: (id: number) => void;
    bridge.start = () =>
      new Promise((done) => {
        resolve = done;
      });
    const client = new CLIClient(bridge);
    const pending = client.connect(address);
    client.close();
    resolve(7);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(bridge.close).toHaveBeenCalledWith(7);
    expect(bridge.connect).not.toHaveBeenCalled();
  });
  it("times out an unresponsive listing and ignores a late result", async () => {
    vi.useFakeTimers();
    try {
      const bridge = transport();
      let resolve!: (value: string) => void;
      bridge.connect = () =>
        new Promise((done) => {
          resolve = done;
        });
      const client = new CLIClient(bridge);
      const pending = expect(client.connect(address)).rejects.toThrow(
        /timed out.*Reconnect/,
      );
      await vi.advanceTimersByTimeAsync(65_000);
      await pending;
      expect(client.closed).toBe(true);
      expect(bridge.close).toHaveBeenCalledOnce();
      resolve(
        JSON.stringify({
          entries: [entry],
          skipped: 0,
          done: true,
          cursor: "",
        }),
      );
      await Promise.resolve();
      expect(client.manifest).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels a listing without waiting for the transport to answer", async () => {
    const bridge = transport();
    bridge.connect = vi.fn(() => new Promise<string>(() => {}));
    const client = new CLIClient(bridge);
    const pending = expect(client.connect(address)).rejects.toThrow(
      /cancelled/,
    );
    await Promise.resolve();
    expect(bridge.connect).toHaveBeenCalledOnce();
    client.close();
    await pending;
    expect(bridge.close).toHaveBeenCalledOnce();
  });
  it("cleans up a synchronous transport failure without leaving a timer", async () => {
    vi.useFakeTimers();
    try {
      const bridge = transport();
      bridge.connect = () => {
        throw new Error("Worker unavailable");
      };
      const client = new CLIClient(bridge);
      await expect(client.connect(address)).rejects.toThrow(
        /Worker unavailable/,
      );
      expect(bridge.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("aborts a transfer cancelled during a write", async () => {
    const client = new CLIClient(transport());
    await client.connect(address);
    const out = capture();
    out.sink.write = async () => {
      client.close();
    };
    await expect(client.receive(entry, out.sink)).rejects.toThrow(/cancelled/);
    expect(out.sink.close).not.toHaveBeenCalled();
    expect(out.sink.abort).toHaveBeenCalledOnce();
  });
  it("uses the existing ZIP writer for CLI files and empty folders", async () => {
    const entries: Entry[] = [
      {
        id: "Zm9sZGVy." + "a".repeat(43),
        path: "folder",
        size: 0,
        modified: 0,
        kind: "directory",
      },
      { ...entry, path: "folder/file.txt" },
    ];
    const bridge = transport([entries[0]]);
    bridge.directory = vi.fn(async (_id, op) =>
      JSON.stringify({
        entries: op === "open" ? [entries[1]] : [],
        skipped: 0,
        done: true,
        cursor: "",
      }),
    );
    const client = new CLIClient(bridge);
    await client.connect(address);
    const out = capture();
    await downloadZip(client, client.walk([entries[0]]), out.sink, () => {});
    const zip = unzipSync(Buffer.concat(out.bytes));
    expect(Object.keys(zip)).toEqual(["folder/", "folder/file.txt"]);
    expect(zip["folder/file.txt"]).toEqual(new Uint8Array([1, 2, 3]));
    expect(out.sink.close).toHaveBeenCalledOnce();
  });
});
