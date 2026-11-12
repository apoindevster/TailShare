import { afterEach, expect, it, vi } from "vitest";
import { downloadCLI } from "../src/lib/cli-download";
import { CLI_ROOT, type CLIClient } from "../src/lib/cli";
import type { Entry } from "../src/lib/model";
import type { DirectoryHandle } from "../src/lib/picker";
import type { Sink } from "../src/lib/session";

afterEach(() => vi.unstubAllGlobals());
function disk() {
  const written = new Map<string, Uint8Array>();
  function folder(name: string, prefix = ""): DirectoryHandle {
    const path = prefix ? `${prefix}/${name}` : name;
    const dirs = new Map<string, DirectoryHandle>();
    return {
      name,
      kind: "directory",
      async *values() {},
      async getDirectoryHandle(child, options) {
        if (!dirs.has(child) && options?.create)
          dirs.set(child, folder(child, path));
        if (!dirs.has(child))
          throw new DOMException("missing", "NotFoundError");
        return dirs.get(child)!;
      },
      async getFileHandle(child, options) {
        const key = `${path}/${child}`;
        if (!written.has(key) && !options?.create)
          throw new DOMException("missing", "NotFoundError");
        if (!written.has(key)) written.set(key, new Uint8Array());
        return {
          name: child,
          kind: "file",
          getFile: async () => new File([], child),
          createWritable: async () => ({
            write: async (data) => {
              written.set(key, data);
            },
            close: async () => {},
            abort: async () => {},
          }),
        };
      },
    };
  }
  return { root: folder("destination"), written };
}
function source(entries: Entry[], events: string[]) {
  return {
    closed: false,
    async *walk() {
      events.push("walk");
      for (const entry of entries) yield entry;
    },
    async receive(_entry: Entry, sink: Sink) {
      await sink.write(new Uint8Array([42]));
      await sink.close();
    },
  } as unknown as CLIClient;
}
const entry: Entry = {
  id: "file",
  path: "folder/file.txt",
  kind: "file",
  size: 1,
  modified: 0,
};
it("chooses the destination before walking and saves unopened folder contents", async () => {
  const events: string[] = [];
  const out = disk();
  vi.stubGlobal("window", {
    showSaveFilePicker: vi.fn(),
    showDirectoryPicker: async () => {
      events.push("picker");
      return out.root;
    },
  });
  const client = source(
    [
      { ...entry, id: "folder", path: "folder", kind: "directory", size: 0 },
      entry,
    ],
    events,
  );
  expect(await downloadCLI(client, [CLI_ROOT], "separate", () => {})).toBe(1);
  expect(events).toEqual(["picker", "walk"]);
  expect([...out.written.values()]).toEqual([new Uint8Array([42])]);
});
it("refuses duplicate separate-download paths without overwriting an earlier file", async () => {
  const out = disk();
  vi.stubGlobal("window", {
    showSaveFilePicker: vi.fn(),
    showDirectoryPicker: async () => out.root,
  });
  const client = source([entry, { ...entry, id: "duplicate" }], []);
  await expect(
    downloadCLI(client, [CLI_ROOT], "separate", () => {}),
  ).rejects.toThrow(/already exists/);
  expect([...out.written.values()]).toEqual([new Uint8Array([42])]);
});
it("does not walk after the user cancels the destination picker", async () => {
  const events: string[] = [];
  vi.stubGlobal("window", {
    showSaveFilePicker: vi.fn(),
    showDirectoryPicker: async () => {
      throw new DOMException("cancelled", "AbortError");
    },
  });
  await expect(
    downloadCLI(source([entry], events), [CLI_ROOT], "separate", () => {}),
  ).rejects.toThrow(/cancelled/);
  expect(events).toEqual([]);
});
