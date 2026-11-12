import { Zip, ZipPassThrough } from "fflate";
import {
  type Entry,
  MEMORY_LIMIT,
  ZIP_LIMIT,
  fileName,
  safePath,
} from "./model";
import { type Sink, type Progress } from "./session";
import type { FileReceiver } from "./cli";

interface FileWritable {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface SaveHandle {
  createWritable(): Promise<FileWritable>;
}
declare global {
  interface Window {
    showSaveFilePicker?: (options: {
      suggestedName: string;
    }) => Promise<SaveHandle>;
  }
}
export const canStreamToDisk = () =>
  typeof window.showSaveFilePicker === "function";
export function memorySink(
  name: string,
  maximum: number,
  save = saveBlob,
): Sink {
  let size = 0;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  return {
    async write(bytes) {
      size += bytes.length;
      if (size > maximum || size > MEMORY_LIMIT)
        throw new Error(
          "This download exceeds the browser memory limit. Use desktop Chrome or Edge.",
        );
      parts.push(new Uint8Array(bytes));
    },
    async close() {
      save(new Blob(parts, { type: "application/octet-stream" }), name);
      parts.length = 0;
    },
    async abort() {
      parts.length = 0;
    },
  };
}
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export async function chooseSink(name: string, size: number): Promise<Sink> {
  if (canStreamToDisk()) {
    const handle = await window.showSaveFilePicker!({ suggestedName: name });
    return handle.createWritable();
  }
  if (size > MEMORY_LIMIT)
    throw new Error(
      "This browser can save up to 256 MB per download. Use desktop Chrome or Edge for larger files.",
    );
  return memorySink(name, size);
}
export function zipSizeBound(entries: Entry[]) {
  return entries.reduce(
    (n, e) => n + e.size + new TextEncoder().encode(e.path).length * 2 + 128,
    22,
  );
}
export async function downloadZip(
  client: FileReceiver,
  entries: Iterable<Entry> | AsyncIterable<Entry>,
  output: Sink,
  progress: (p: Progress) => void,
) {
  if (Array.isArray(entries) && zipSizeBound(entries) > ZIP_LIMIT) {
    await output.abort();
    throw new Error(
      "ZIP downloads are limited to 4 GB. Download these files separately.",
    );
  }
  let archiveBound = 22;
  let centralBytes = 0;
  let count = 0;
  const seen = new Set<string>();
  const kinds = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();
  let failed: unknown;
  const zip = new Zip((error, data) => {
    if (error) {
      failed = error;
      return;
    }
    // Each stored chunk produces output synchronously. Await after every push to bound this queue.
    queue = queue.then(() => output.write(data));
    queue.catch((error) => {
      failed = error;
    });
  });
  const flush = async () => {
    await queue;
    if (failed) throw failed;
  };
  try {
    for await (const entry of entries) {
      const checked = safePath(entry.path);
      const key = checked.toLowerCase();
      archiveBound += zipSizeBound([entry]) - 22;
      centralBytes += new TextEncoder().encode(checked).length + 128;
      if (++count > 65_535 || centralBytes > 8 * 1024 * 1024)
        throw new Error(
          "This ZIP exceeds the archive entry or metadata limit. Download smaller folders separately.",
        );
      if (archiveBound > ZIP_LIMIT)
        throw new Error(
          "ZIP downloads are limited to 4 GB. Download smaller folders or separate files.",
        );
      if (seen.has(key) || (kinds.has(key) && kinds.get(key) !== entry.kind))
        throw new Error("Duplicate paths in the CLI folder. ZIP discarded.");
      seen.add(key);
      kinds.set(key, entry.kind);
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (kinds.get(parent) === "file")
          throw new Error(
            "Conflicting paths in the CLI folder. ZIP discarded.",
          );
        kinds.set(parent, "directory");
      }
      const zipped = new ZipPassThrough(
        safePath(entry.path) + (entry.kind === "directory" ? "/" : ""),
      );
      zip.add(zipped);
      if (entry.kind === "directory") {
        zipped.push(new Uint8Array(), true);
        await flush();
        continue;
      }
      await client.receive(
        entry,
        {
          async write(bytes) {
            zipped.push(bytes);
            await flush();
          },
          async close() {
            zipped.push(new Uint8Array(), true);
            await flush();
          },
          async abort() {
            zip.terminate();
          },
        },
        progress,
      );
    }
    zip.end();
    await flush();
    await output.close();
  } catch (error) {
    zip.terminate();
    await output.abort().catch(() => {});
    throw error;
  }
}
export async function downloadFile(
  client: FileReceiver,
  entry: Entry,
  progress: (p: Progress) => void,
) {
  const sink = await chooseSink(fileName(entry.path), entry.size);
  await client.receive(entry, sink, progress);
}

// One user gesture chooses a destination for a batch. A fresh child folder prevents
// overwriting existing files; nested share paths are validated before directory creation.
export async function downloadSeparate(
  client: FileReceiver,
  entries: Entry[],
  progress: (p: Progress) => void,
) {
  if (entries.length === 1) return downloadFile(client, entries[0], progress);
  if (window.showDirectoryPicker && canStreamToDisk()) {
    const parent = await window.showDirectoryPicker({ mode: "readwrite" });
    const root = await parent.getDirectoryHandle(
      "TailShare-" + crypto.randomUUID(),
      { create: true },
    );
    for (const entry of entries) {
      const parts = safePath(entry.path).split("/");
      let folder = root;
      for (const part of parts.slice(0, -1))
        folder = await folder.getDirectoryHandle(part, { create: true });
      const handle = await folder.getFileHandle(parts.at(-1)!, {
        create: true,
      });
      await client.receive(entry, await handle.createWritable(), progress);
    }
    return;
  }
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total > MEMORY_LIMIT)
    throw new Error(
      "Separate downloads in this browser are limited to 256 MB per batch. Select fewer files or use desktop Chrome or Edge.",
    );
  for (const entry of entries)
    await client.receive(
      entry,
      memorySink(fileName(entry.path), entry.size),
      progress,
    );
}
