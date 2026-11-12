import {
  type Entry,
  type LocalShare,
  validateManifest,
  ZIP_LIMIT,
} from "./model";
import { type FileReceiver, wasmCLI, CLI_BATCH } from "./cli";
import { downloadZip, zipSizeBound } from "./download";
import { type Progress, type Sink } from "./session";
import { DERP_MAP } from "./transport";
import { MAX_JSON } from "./wire";

export type UploadMode = "flat" | "tree" | "zip";
export interface CLIUploadTransport {
  start(): Promise<number>;
  connect(id: number, key: string, plan: string): Promise<string>;
  file(
    id: number,
    op: "open" | "write" | "finish",
    value?: string | Uint8Array,
  ): Promise<void>;
  close(id: number): void;
}
declare global {
  interface Window {
    tailshareCLIUpload: CLIUploadTransport["file"];
  }
}
const bridge: CLIUploadTransport = {
  start: wasmCLI.start,
  close: wasmCLI.close,
  connect: (id, key, plan) =>
    window.tailshareCLIConnect(id, key, DERP_MAP, plan),
  file: (id, op, value) => window.tailshareCLIUpload(id, op, value),
};
const UPLOAD_CHUNK = CLI_BATCH;

export class CLISender {
  private id?: number;
  private stopped = false;
  private started = false;
  constructor(private transport: CLIUploadTransport = bridge) {}
  close() {
    this.stopped = true;
    if (this.id !== undefined) this.transport.close(this.id);
    this.id = undefined;
  }
  private live() {
    if (this.stopped) throw new Error("CLI upload cancelled.");
  }
  async send(
    key: string,
    share: LocalShare,
    mode: UploadMode,
    progress: (p: Progress) => void = () => {},
  ) {
    if (this.started)
      throw new Error("Start a new CLI transfer before sending again.");
    this.started = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.close(), 120_000);
    };
    try {
      this.live();
      if (!/^tc[a-zA-Z0-9_-]{20,2048}$/.test(key.trim()))
        throw new Error("Paste the tc… receiver key from tailcat recv.");
      if (!["flat", "tree", "zip"].includes(mode))
        throw new Error("Choose a supported CLI transfer format.");
      // Snapshot and validate the entire local selection before connecting or writing.
      const { entries } = validateManifest({
        version: 1,
        entries: share.entries,
        expiresAt: null,
      });
      const files = new Map(share.files);
      if (!entries.length) throw new Error("Choose files or a folder first.");
      for (const e of entries) {
        if (
          e.kind === "file" &&
          (!files.has(e.id) || files.get(e.id)!.size !== e.size)
        )
          throw new Error(
            "Your file selection changed. Choose the files again.",
          );
      }
      if (mode === "flat" && !entries.some((e) => e.kind === "file"))
        throw new Error("Use a ZIP or folder tree to send empty folders.");
      const zipEntry: Entry = {
        id: "zip",
        path: "TailShare.zip",
        kind: "file",
        size: zipSizeBound(entries),
        modified: 0,
      };
      if (mode === "zip" && zipEntry.size > ZIP_LIMIT)
        throw new Error(
          "ZIP uploads are limited to 4 GB. Send files separately or as a folder tree.",
        );
      const plan = JSON.stringify({
        mode,
        entries: mode === "zip" ? [zipEntry] : entries,
      });
      if (new TextEncoder().encode(plan).length > MAX_JSON)
        throw new Error("File names exceed the sharing metadata limit.");
      touch();
      const id = await this.transport.start();
      if (this.stopped) {
        this.transport.close(id);
        this.live();
      }
      this.id = id;
      const root = await this.transport.connect(id, key.trim(), plan);
      this.live();
      touch();
      if (
        (mode === "tree" && !/^TailShare-[a-f0-9]{32}$/.test(root)) ||
        (mode !== "tree" && root !== "")
      )
        throw new Error("Invalid CLI upload destination.");
      const source: FileReceiver = {
        closed: false,
        close: () => this.close(),
        disconnect: async () => this.close(),
        receive: async (entry, sink, update = () => {}) => {
          const file = files.get(entry.id)!;
          let offset = 0;
          update({ entry, bytes: 0, total: entry.size });
          while (offset < entry.size) {
            this.live();
            const end = Math.min(offset + UPLOAD_CHUNK, entry.size);
            const bytes = new Uint8Array(
              await file.slice(offset, end).arrayBuffer(),
            );
            this.live();
            if (bytes.length !== end - offset)
              throw new Error(
                "Could not read the complete local file. Choose it again.",
              );
            await sink.write(bytes);
            this.live();
            touch();
            offset = end;
            update({ entry, bytes: offset, total: entry.size });
          }
          this.live();
          await sink.close();
        },
      };
      const sinkFor = async (entry: Entry): Promise<Sink> => {
        this.live();
        await this.transport.file(id, "open", entry.id);
        this.live();
        touch();
        let buffered = new Uint8Array(UPLOAD_CHUNK);
        let used = 0;
        const flush = async () => {
          if (!used) return;
          this.live();
          await this.transport.file(id, "write", buffered.subarray(0, used));
          this.live();
          used = 0;
          touch();
        };
        return {
          write: async (bytes) => {
            for (let offset = 0; offset < bytes.length; ) {
              this.live();
              const count = Math.min(
                UPLOAD_CHUNK - used,
                bytes.length - offset,
              );
              buffered.set(bytes.subarray(offset, offset + count), used);
              used += count;
              offset += count;
              if (used === UPLOAD_CHUNK) await flush();
            }
          },
          close: async () => {
            this.live();
            await flush();
            await this.transport.file(id, "finish");
            this.live();
            touch();
          },
          abort: async () => {
            used = 0;
            buffered = new Uint8Array();
            this.close();
          },
        };
      };
      if (mode === "zip")
        await downloadZip(source, entries, await sinkFor(zipEntry), progress);
      else
        for (const entry of entries)
          if (entry.kind === "file")
            await source.receive(entry, await sinkFor(entry), progress);
      this.live();
      return { root, files: entries.filter((e) => e.kind === "file").length };
    } finally {
      clearTimeout(timer);
      this.close();
    }
  }
}
