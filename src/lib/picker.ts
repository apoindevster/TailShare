import { MAX_ENTRIES, createShare } from "./model";
export interface DirectoryHandle {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileHandle>;
  name: string;
  kind: "directory";
  values(): AsyncIterable<DirectoryHandle | FileHandle>;
}
interface FileHandle {
  createWritable(): Promise<import("./session").Sink>;
  name: string;
  kind: "file";
  getFile(): Promise<File>;
}
declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: "read" | "readwrite";
    }) => Promise<DirectoryHandle>;
  }
}
function relativeFile(file: File, path: string) {
  Object.defineProperty(file, "webkitRelativePath", {
    value: path,
    configurable: true,
  });
  return file;
}
export async function pickDirectory() {
  const root = await window.showDirectoryPicker!();
  const files: File[] = [];
  const dirs: string[] = [];
  async function walk(handle: DirectoryHandle, path: string, depth: number) {
    if (depth > 32 || files.length + dirs.length >= MAX_ENTRIES)
      throw new Error(
        "This folder exceeds the limit of 10,000 entries or 32 nested folders.",
      );
    dirs.push(path);
    for await (const child of handle.values()) {
      if (child.kind === "directory")
        await walk(child, path + "/" + child.name, depth + 1);
      else {
        if (files.length + dirs.length >= MAX_ENTRIES)
          throw new Error("Choose fewer than 10,000 files and folders.");
        files.push(
          relativeFile(await child.getFile(), path + "/" + child.name),
        );
      }
    }
  }
  await walk(root, root.name, 1);
  return createShare(files, dirs);
}
export async function droppedFiles(transfer: DataTransfer) {
  const files: File[] = [];
  const directories: string[] = [];
  let count = 0;
  async function walk(entry: FileSystemEntry, prefix: string, depth: number) {
    if (++count > MAX_ENTRIES || depth > 32)
      throw new Error(
        "This selection exceeds the folder limit. Choose fewer files.",
      );
    const path = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push(relativeFile(file, path));
    } else if (entry.isDirectory) {
      directories.push(path);
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const entries = await new Promise<FileSystemEntry[]>(
          (resolve, reject) => reader.readEntries(resolve, reject),
        );
        if (!entries.length) break;
        for (const child of entries) await walk(child, path + "/", depth + 1);
      }
    }
  }
  const entries = Array.from(transfer.items)
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.());
  if (entries.length && entries.every(Boolean))
    for (const entry of entries) await walk(entry!, "", 1);
  else files.push(...Array.from(transfer.files));
  return createShare(files, directories);
}
