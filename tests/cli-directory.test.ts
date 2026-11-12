import { describe, expect, it, vi } from "vitest";
import {
  CLIClient,
  CLI_ROOT,
  CLI_PAGE_SIZE,
  validateCLIPage,
  type CLITransport,
} from "../src/lib/cli";
import { downloadZip } from "../src/lib/download";
import { unzipSync } from "fflate";
import type { Entry } from "../src/lib/model";
import type { Sink } from "../src/lib/session";

const token = (path: string) =>
  Buffer.from(path).toString("base64url") + "." + "a".repeat(43);
const file = (path: string): Entry => ({
  id: token(path),
  path,
  kind: "file",
  size: 0,
  modified: 0,
});
const folder = (path: string): Entry => ({ ...file(path), kind: "directory" });
function paged(tree: Map<string, Entry[]>) {
  const open: string[] = [];
  const cursors = new Map<string, { parent: string; index: number }>();
  let serial = 0;
  function page(parent: string, index: number) {
    const all = tree.get(parent) ?? [];
    const entries = all.slice(index, index + CLI_PAGE_SIZE);
    const done = index + entries.length >= all.length;
    const cursor = done ? "" : (++serial).toString(16).padStart(32, "0");
    if (cursor) cursors.set(cursor, { parent, index: index + entries.length });
    return JSON.stringify({ entries, done, cursor, skipped: 0 });
  }
  const bridge: CLITransport = {
    start: vi.fn(async () => 1),
    connect: vi.fn(async () => page("", 0)),
    directory: vi.fn(async (_id, op, value) => {
      if (op === "close") {
        cursors.delete(value);
        return "{}";
      }
      if (op === "open") {
        const parent = value
          ? Buffer.from(value.split(".")[0], "base64url").toString()
          : "";
        open.push(parent);
        return page(parent, 0);
      }
      const next = cursors.get(value);
      if (!next) throw new Error("Expired cursor");
      cursors.delete(value);
      return page(next.parent, next.index);
    }),
    file: vi.fn(async () => null),
    close: vi.fn(() => cursors.clear()),
  };
  return { bridge, open, cursors };
}
function output() {
  const chunks: Uint8Array[] = [];
  const sink: Sink = {
    write: vi.fn(async (b) => {
      chunks.push(b);
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  return { sink, chunks };
}

describe("paged CLI browsing", () => {
  it("loads only the root and navigates past 10,000 files, with previous-page reload and refresh", async () => {
    const dir = folder("large");
    const entries = Array.from({ length: 10_050 }, (_, i) =>
      file(`large/file-${i}.txt`),
    );
    const fixture = paged(
      new Map([
        ["", [dir]],
        [dir.path, entries],
      ]),
    );
    const client = new CLIClient(fixture.bridge);
    const root = await client.connect("synthetic");
    expect(root.entries).toEqual([dir]);
    expect(fixture.open).toEqual([]);
    let page = await client.browse(dir);
    let count = page.entries.length;
    while (!page.done) {
      page = await client.browse(dir, client.pageNumber + 1);
      count += page.entries.length;
    }
    expect(count).toBe(10_050);
    expect((await client.browse(dir, 0)).entries[0].path).toBe(
      "large/file-0.txt",
    );
    expect(fixture.open).toEqual(["large", "large"]); // first page was evicted from the cache
    treeChange();
    await client.browse(dir, 0, true);
    expect(client.page!.entries[0].path).toBe("large/new.txt");
    await client.browse(CLI_ROOT);
    expect(fixture.cursors.size).toBe(0);
    function treeChange() {
      entries[0] = file("large/new.txt");
    }
  });
  it("caches recent pages without replaying a consumed cursor", async () => {
    const fixture = paged(
      new Map([["", Array.from({ length: 400 }, (_, i) => file(`${i}.txt`))]]),
    );
    const client = new CLIClient(fixture.bridge);
    await client.connect("synthetic");
    await client.browse(CLI_ROOT, 1);
    await client.browse(CLI_ROOT, 0);
    await client.browse(CLI_ROOT, 1);
    expect(fixture.bridge.directory).toHaveBeenCalledTimes(1);
    await client.browse(CLI_ROOT, 2);
    expect(client.page!.entries[0].path).toBe("256.txt");
  });
  it("keeps the session usable after a folder disappears or becomes unreadable", async () => {
    const dir = folder("removed");
    const entries = [dir, file("remaining.txt")];
    const fixture = paged(new Map([["", entries]]));
    const directory = fixture.bridge.directory;
    fixture.bridge.directory = vi.fn(
      async (...args: Parameters<CLITransport["directory"]>) => {
        if (args[1] === "open" && args[2] === dir.id)
          return JSON.stringify({
            error: "CLI folder no longer exists. Refresh its parent folder",
          });
        return directory(...args);
      },
    );
    const client = new CLIClient(fixture.bridge);
    await client.connect("synthetic");
    await expect(client.browse(dir)).rejects.toThrow(/no longer exists/);
    expect(client.closed).toBe(false);
    entries.shift();
    const refreshed = await client.browse(CLI_ROOT, 0, true);
    expect(refreshed.entries.map((entry) => entry.path)).toEqual([
      "remaining.txt",
    ]);
    const out = output();
    await client.receive(refreshed.entries[0], out.sink);
    expect(out.sink.close).toHaveBeenCalledOnce();
  });
  it("walks unopened descendants on demand and closes cursors when stopped early", async () => {
    const dir = folder("nested");
    const fixture = paged(
      new Map([
        ["", [dir, ...Array.from({ length: 300 }, (_, i) => file(`${i}.txt`))]],
        ["nested", [file("nested/secret.txt")]],
      ]),
    );
    const client = new CLIClient(fixture.bridge);
    await client.connect("synthetic");
    expect(fixture.open).toEqual([]);
    const walk = client.walk();
    expect((await walk.next()).value).toEqual(dir);
    expect(fixture.open).toEqual([""]);
    expect((await walk.next()).value!.path).toBe("nested/secret.txt");
    await walk.return(undefined);
    expect(fixture.cursors.size).toBe(1); // only the original browsing cursor remains
    client.close();
    expect(fixture.cursors.size).toBe(0);
  });
  it("rejects sibling escapes, duplicate paths and oversized pages", () => {
    for (const entries of [
      [file("elsewhere.txt")],
      [file("a/same"), file("a/SAME")],
      Array.from({ length: 129 }, (_, i) => file(`a/${i}`)),
    ])
      expect(() =>
        validateCLIPage(
          JSON.stringify({ entries, skipped: 0, cursor: "", done: true }),
          "a",
        ),
      ).toThrow();
  });
  it("closes the session when a paged request never answers", async () => {
    vi.useFakeTimers();
    try {
      const fixture = paged(
        new Map([["", Array.from({ length: 200 }, (_, i) => file(`${i}`))]]),
      );
      const client = new CLIClient(fixture.bridge);
      await client.connect("synthetic");
      fixture.bridge.directory = vi.fn(() => new Promise<string>(() => {}));
      const result = expect(client.browse(CLI_ROOT, 1)).rejects.toThrow(
        /timed out/,
      );
      await vi.advanceTimersByTimeAsync(65_000);
      await result;
      expect(client.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("incremental CLI archives", () => {
  it("archives more than 10,000 entries without a whole-tree manifest", async () => {
    const fixture = paged(
      new Map([
        ["", Array.from({ length: 10_050 }, (_, i) => file(`${i}.txt`))],
      ]),
    );
    const client = new CLIClient(fixture.bridge);
    await client.connect("synthetic");
    const out = output();
    await downloadZip(client, client.walk(), out.sink, () => {});
    const files = unzipSync(Buffer.concat(out.chunks));
    expect(Object.keys(files)).toHaveLength(10_050);
    expect(files["10049.txt"]).toHaveLength(0);
    expect(out.sink.close).toHaveBeenCalledOnce();
    expect(out.sink.abort).not.toHaveBeenCalled();
  });
  it("discards a ZIP on a duplicate path spanning different directory pages", async () => {
    const list = [
      ...Array.from({ length: 128 }, (_, i) => file(`${i}.txt`)),
      file("0.txt"),
    ];
    const fixture = paged(new Map([["", list]]));
    const client = new CLIClient(fixture.bridge);
    await client.connect("synthetic");
    const out = output();
    await expect(
      downloadZip(client, client.walk(), out.sink, () => {}),
    ).rejects.toThrow(/Duplicate paths/);
    expect(out.sink.abort).toHaveBeenCalledOnce();
    expect(out.sink.close).not.toHaveBeenCalled();
  });
});
