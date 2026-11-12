import { CLIClient } from "./cli";
import {
  canStreamToDisk,
  chooseSink,
  downloadSeparate,
  downloadZip,
  memorySink,
} from "./download";
import {
  fileName,
  MEMORY_LIMIT,
  safePath,
  ZIP_LIMIT,
  type Entry,
} from "./model";
import type { Progress } from "./session";
import type { DirectoryHandle } from "./picker";

// Ask for a destination during the user's gesture, before enumerating unseen
// folders. Traversal and file reads then proceed with bounded backpressure.
export async function downloadCLI(
  client: CLIClient,
  selection: Entry[],
  kind: "zip" | "separate",
  progress: (p: Progress) => void,
  discovered: (files: number) => void = () => {},
) {
  let files = 0;
  async function* entries() {
    for await (const entry of client.walk(selection)) {
      if (entry.kind === "file") discovered(++files);
      yield entry;
    }
  }
  if (kind === "zip") {
    const output = await chooseSink(
      "TailShare.zip",
      canStreamToDisk() ? ZIP_LIMIT : MEMORY_LIMIT,
    );
    await downloadZip(client, entries(), output, progress);
  } else if (selection.length === 1 && selection[0].kind === "file") {
    await downloadSeparate(client, selection, progress);
    discovered(++files);
  } else {
    let destination: DirectoryHandle | undefined;
    if (window.showDirectoryPicker && canStreamToDisk()) {
      const parent = await window.showDirectoryPicker({ mode: "readwrite" });
      destination = await parent.getDirectoryHandle(
        "TailShare-" + crypto.randomUUID(),
        { create: true },
      );
    }
    let memoryBytes = 0;
    for await (const entry of entries()) {
      if (client.closed) throw new Error("CLI download cancelled.");
      if (destination) {
        const parts = safePath(entry.path).split("/");
        let folder = destination;
        for (const part of entry.kind === "directory"
          ? parts
          : parts.slice(0, -1)) {
          folder = await folder.getDirectoryHandle(part, { create: true });
          if (folder.name !== part)
            throw new Error(
              "Conflicting folder names. Earlier files may already be saved.",
            );
        }
        if (entry.kind === "directory") continue;
        const name = parts.at(-1)!;
        // Repeated or case-colliding names must never overwrite earlier output.
        try {
          await folder.getFileHandle(name);
          throw new Error(
            "A download path already exists. Earlier files may already be saved.",
          );
        } catch (error) {
          if (
            !(error instanceof DOMException && error.name === "NotFoundError")
          )
            throw error;
        }
        const handle = await folder.getFileHandle(name, { create: true });
        await client.receive(entry, await handle.createWritable(), progress);
      } else if (entry.kind === "file") {
        memoryBytes += entry.size;
        if (memoryBytes > MEMORY_LIMIT)
          throw new Error(
            "Separate downloads exceed 256 MB in this browser. Earlier files may already be saved; use desktop Chrome or Edge for a larger batch.",
          );
        await client.receive(
          entry,
          memorySink(fileName(entry.path), entry.size),
          progress,
        );
      }
    }
  }
  return files;
}
