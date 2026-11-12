import { type Entry, type Manifest, safePath } from "./model";
import { type Progress, type Sink } from "./session";
import { DERP_MAP, loadTransport } from "./transport";

export const CLI_BATCH = 256 * 1024;

export interface FileReceiver {
  readonly closed: boolean;
  receive(
    entry: Entry,
    sink: Sink,
    progress?: (p: Progress) => void,
  ): Promise<void>;
  close(): void;
  disconnect(): Promise<void>;
}

export interface CLITransport {
  start(): Promise<number>;
  connect(id: number, address: string): Promise<string>;
  directory(
    id: number,
    op: "open" | "next" | "close",
    value: string,
  ): Promise<string>;
  file(
    id: number,
    op: "open" | "read" | "finish",
    entryID?: string,
  ): Promise<Uint8Array | null>;
  close(id: number): void;
}

declare global {
  interface Window {
    tailshareCLIStart(): Promise<number>;
    tailshareCLIConnect(
      id: number,
      address: string,
      mapURL: string,
      uploadJSON?: string,
    ): Promise<string>;
    tailshareCLIFile: CLITransport["file"];
    tailshareCLIDirectory: CLITransport["directory"];
    tailshareCLIClose(id: number): void;
  }
}

export const wasmCLI: CLITransport = {
  async start() {
    await loadTransport();
    const id = await window.tailshareCLIStart();
    if (id < 0) throw new Error("Disconnect another CLI share and try again.");
    return id;
  },
  connect: (id, address) => window.tailshareCLIConnect(id, address, DERP_MAP),
  directory: (id, op, value) => window.tailshareCLIDirectory(id, op, value),
  file: (id, op, entryID) => window.tailshareCLIFile(id, op, entryID),
  close: (id) => window.tailshareCLIClose(id),
};

export const CLI_PAGE_SIZE = 128;
export const CLI_ROOT: Entry = {
  id: "",
  path: "",
  kind: "directory",
  size: 0,
  modified: 0,
};
export type CLIPage = {
  entries: Entry[];
  skipped: number;
  cursor: string;
  done: boolean;
};

class CLIListingError extends Error {}

// Validate one page, without assuming that its ancestors or siblings are loaded.
export function validateCLIPage(json: string, parent: string): CLIPage {
  if (new TextEncoder().encode(json).length > 1024 * 1024)
    throw new Error("CLI page exceeds the metadata limit.");
  const raw = JSON.parse(json) as CLIPage & { error?: string };
  if (raw && typeof raw.error === "string" && raw.error.length <= 512)
    throw new CLIListingError(raw.error);
  if (
    !raw ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > CLI_PAGE_SIZE ||
    !Number.isSafeInteger(raw.skipped) ||
    raw.skipped < 0 ||
    raw.skipped > CLI_PAGE_SIZE ||
    typeof raw.done !== "boolean" ||
    typeof raw.cursor !== "string" ||
    (raw.done ? raw.cursor !== "" : !/^[a-f0-9]{32}$/.test(raw.cursor))
  )
    throw new Error("Invalid CLI directory page.");
  const names = new Set<string>();
  const ids = new Set<string>();
  const entries = raw.entries.map((e) => {
    if (
      !e ||
      typeof e.id !== "string" ||
      e.id.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(e.id) ||
      ids.has(e.id) ||
      !["file", "directory"].includes(e.kind) ||
      !Number.isSafeInteger(e.size) ||
      e.size < 0 ||
      (e.kind === "directory" && e.size !== 0) ||
      !Number.isSafeInteger(e.modified) ||
      e.modified < 0
    )
      throw new Error("Invalid CLI file metadata.");
    const path = safePath(e.path);
    if (
      path.split("/").slice(0, -1).join("/") !== parent ||
      names.has(path.toLowerCase())
    )
      throw new Error("Unsafe or duplicate CLI directory paths.");
    names.add(path.toLowerCase());
    ids.add(e.id);
    return { id: e.id, path, kind: e.kind, size: e.size, modified: e.modified };
  });
  return { entries, skipped: raw.skipped, cursor: raw.cursor, done: raw.done };
}

export class CLIClient implements FileReceiver {
  private id?: number;
  private stopped = false;
  private busy = false;
  private browsing = false;
  private pending = new Set<(error: Error) => void>();
  private known = new Map<string, Entry>();
  private cache = new Map<number, CLIPage>();
  private folder = CLI_ROOT;
  private cursor = "";
  private fetched = 0;
  page?: CLIPage;
  pageNumber = 0;
  manifest?: Manifest;
  skipped = 0;
  constructor(private transport: CLITransport = wasmCLI) {}
  get closed() {
    return this.stopped;
  }
  close() {
    this.stopped = true;
    for (const reject of this.pending)
      reject(new Error("CLI connection cancelled."));
    this.pending.clear();
    if (this.id !== undefined) this.transport.close(this.id);
    this.id = undefined;
    this.known.clear();
    this.cache.clear();
    this.page = undefined;
  }
  async disconnect() {
    this.close();
  }
  private async request<T>(call: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("CLI connection cancelled.");
    let reject!: (error: Error) => void;
    const interrupted = new Promise<never>((_, fail) => {
      reject = fail;
    });
    this.pending.add(reject);
    const timer = setTimeout(() => {
      reject(
        new Error(
          "Reading this CLI folder timed out. Reconnect and try again.",
        ),
      );
      this.close();
    }, 65_000);
    try {
      return await Promise.race([(async () => call())(), interrupted]);
    } finally {
      clearTimeout(timer);
      this.pending.delete(reject);
    }
  }
  private remember(entries: Entry[]) {
    for (const e of entries) {
      this.known.delete(e.id);
      this.known.set(e.id, e);
      if (this.known.size > 1024)
        this.known.delete(this.known.keys().next().value!);
    }
  }
  private savePage(index: number, page: CLIPage) {
    this.cache.delete(index);
    this.cache.set(index, page);
    if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
    this.pageNumber = index;
    this.page = page;
    this.skipped = page.skipped;
    this.remember(page.entries);
    return page;
  }
  async connect(address: string) {
    const id = await this.transport.start();
    if (this.stopped) {
      this.transport.close(id);
      throw new Error("CLI connection cancelled.");
    }
    this.id = id;
    try {
      const json = await this.request(() =>
        this.transport.connect(id, address),
      );
      const page = validateCLIPage(json, "");
      if (this.stopped) throw new Error("CLI connection cancelled.");
      this.cursor = page.cursor;
      this.savePage(0, page);
      this.manifest = { version: 1, entries: page.entries, expiresAt: null };
      return this.manifest;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private async list(op: "open" | "next", value: string, parent: string) {
    if (this.id === undefined) throw new Error("Reconnect to the CLI sender.");
    try {
      const json = await this.request(() =>
        this.transport.directory(this.id!, op, value),
      );
      const page = validateCLIPage(json, parent);
      this.remember(page.entries);
      return page;
    } catch (error) {
      if (!(error instanceof CLIListingError)) this.close();
      throw error;
    }
  }

  private async release(cursor: string) {
    if (!cursor || this.id === undefined || this.stopped) return;
    await this.request(() =>
      this.transport.directory(this.id!, "close", cursor),
    );
  }
  async browse(
    folder = CLI_ROOT,
    index = 0,
    refresh = false,
  ): Promise<CLIPage> {
    if (this.browsing || this.busy || !Number.isSafeInteger(index) || index < 0)
      throw new Error("Wait for the current download to finish.");
    this.browsing = true;
    try {
      const changed = folder.id !== this.folder.id;
      if (!changed && !refresh && this.cache.has(index))
        return this.savePage(index, this.cache.get(index)!);
      if (
        changed ||
        refresh ||
        !this.cache.size ||
        index <= this.fetched ||
        (index > this.fetched &&
          !this.cursor &&
          !this.cache.get(this.fetched)?.done)
      ) {
        await this.release(this.cursor);
        this.cursor = "";
        this.cache.clear();
        const page = await this.list("open", folder.id, folder.path);
        this.folder = folder;
        this.fetched = 0;
        this.cursor = page.cursor;
        this.savePage(0, page);
      }
      while (this.fetched < index && this.cursor) {
        const cursor = this.cursor;
        this.cursor = "";
        const page = await this.list("next", cursor, folder.path);
        this.fetched++;
        this.cursor = page.cursor;
        this.savePage(this.fetched, page);
      }
      return this.savePage(this.fetched, this.cache.get(this.fetched)!);
    } finally {
      this.browsing = false;
    }
  }
  // Depth-first traversal retains one bounded page per ancestor and honors
  // consumer backpressure. It never builds a queue for the entire directory tree.
  async *walk(selection: Entry[] = [CLI_ROOT]): AsyncGenerator<Entry> {
    for (const entry of selection) {
      if (this.stopped) throw new Error("CLI connection cancelled.");
      if (entry.kind === "file") {
        this.remember([entry]);
        yield entry;
        continue;
      }
      if (entry.path) {
        this.remember([entry]);
        yield entry;
      }
      let cursor = "";
      try {
        let page = await this.list("open", entry.id, entry.path);
        while (true) {
          cursor = page.cursor;
          for (const child of page.entries) yield* this.walk([child]);
          if (page.done) break;
          const next = cursor;
          cursor = "";
          page = await this.list("next", next, entry.path);
        }
      } finally {
        await this.release(cursor).catch(() => {});
      }
    }
  }
  async receive(
    entry: Entry,
    sink: Sink,
    progress: (p: Progress) => void = () => {},
  ) {
    const known = this.known.get(entry.id);
    if (
      this.id === undefined ||
      this.stopped ||
      this.busy ||
      !known ||
      known.kind !== "file" ||
      known.modified !== entry.modified ||
      known.size !== entry.size ||
      known.path !== entry.path
    ) {
      await sink.abort().catch(() => {});
      throw new Error("Reconnect before downloading.");
    }
    const id = this.id;
    this.busy = true;
    let timer: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.close(), 120_000);
    };
    const ensureLive = () => {
      if (this.stopped)
        throw new Error(
          "CLI download cancelled or disconnected. Download discarded.",
        );
    };
    touch();
    try {
      await this.transport.file(id, "open", entry.id);
      let bytes = 0;
      progress({ entry, bytes, total: entry.size });
      while (true) {
        const chunk = await this.transport.file(id, "read");
        ensureLive();
        touch();
        if (chunk === null) break;
        if (
          !(chunk instanceof Uint8Array) ||
          !chunk.length ||
          chunk.length > CLI_BATCH ||
          bytes + chunk.length > entry.size
        )
          throw new Error("Invalid CLI file length. Download discarded.");
        bytes += chunk.length;
        await sink.write(chunk);
        progress({ entry, bytes, total: entry.size });
      }
      if (bytes !== entry.size)
        throw new Error("Incomplete CLI file. Download discarded.");
      await this.transport.file(id, "finish");
      ensureLive();
      await sink.close();
    } catch (error) {
      this.close();
      await sink.abort().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer!);
      this.busy = false;
    }
  }
}
