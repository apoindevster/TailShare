import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
  type Entry,
  type Invite,
  type LocalShare,
  type Manifest,
  type SharePolicy,
  MAX_SHARE_USES,
  hasExpired,
  shareToken,
  validateManifest,
} from "./model";
import { CHUNK, Wire, type Connection } from "./wire";
import { PORT, tailcat, type Listener, type Transport } from "./transport";

function equalToken(a: unknown, b: string) {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < b.length; i++)
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
export type HostEvent =
  | { type: "peers"; count: number }
  | { type: "sent"; name: string; bytes: number }
  | { type: "uses"; count: number; limit: number | null }
  | { type: "expired"; reason: "time" | "uses" };
export class ShareHost {
  readonly token = shareToken();
  readonly expiresAt: number | null;
  readonly maxUses: number | null;
  private listener?: Listener;
  private connections = new Set<Connection>();
  private peers = 0;
  private uses = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly share: LocalShare,
    policy: SharePolicy = { minutes: 60, maxUses: null },
    private event: (event: HostEvent) => void = () => {},
    private transport: Transport = tailcat,
  ) {
    const { minutes, maxUses } = policy;
    if (
      minutes !== null &&
      (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440)
    )
      throw new Error(
        "Choose an expiry between 1 minute and 24 hours, or Never.",
      );
    if (
      maxUses !== null &&
      (!Number.isSafeInteger(maxUses) ||
        maxUses < 1 ||
        maxUses > MAX_SHARE_USES)
    )
      throw new Error(
        `Choose between 1 and ${MAX_SHARE_USES} recipient connections.`,
      );
    this.expiresAt = minutes === null ? null : Date.now() + minutes * 60_000;
    this.maxUses = maxUses;
    validateManifest({
      version: 1,
      entries: share.entries,
      expiresAt: this.expiresAt,
    });
  }
  async start(): Promise<Invite> {
    const listener = await this.transport.listen((conn) => {
      void this.serve(conn);
    });
    if (this.ended) {
      listener.close();
      throw new Error("Sharing was stopped.");
    }
    this.listener = listener;
    if (this.expiresAt !== null)
      this.timer = setTimeout(
        () => this.expire("time"),
        Math.max(0, this.expiresAt - Date.now()),
      );
    return { address: listener.addr, token: this.token };
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.listener?.close();
    for (const conn of this.connections) conn.close();
    this.connections.clear();
  }
  private get ended() {
    return this.stopped || hasExpired(this.expiresAt);
  }
  private get exhausted() {
    return this.maxUses !== null && this.uses >= this.maxUses;
  }
  private expire(reason: "time" | "uses") {
    if (this.stopped) return;
    this.stop();
    this.event({ type: "expired", reason });
  }
  private async serve(conn: Connection) {
    if (
      this.ended ||
      this.exhausted ||
      conn.port !== PORT ||
      this.connections.size >= 4
    ) {
      conn.close();
      return;
    }
    this.connections.add(conn);
    const wire = new Wire(conn);
    let authenticated = false;
    const authTimer = setTimeout(() => conn.close(), 10_000);
    try {
      const hello = await wire.json(4096);
      if (
        hello.type !== "hello" ||
        hello.version !== 1 ||
        !equalToken(hello.token, this.token)
      )
        throw new Error("Invalid share credentials.");
      // Check again after the asynchronous handshake. Reserve the use before
      // yielding so simultaneous authenticated connections cannot exceed the limit.
      if (this.ended || this.exhausted) throw new Error("Share expired.");
      authenticated = true;
      clearTimeout(authTimer);
      this.peers++;
      this.uses++;
      this.event({ type: "peers", count: this.peers });
      this.event({ type: "uses", count: this.uses, limit: this.maxUses });
      await wire.sendJSON({
        type: "manifest",
        version: 1,
        entries: this.share.entries,
        expiresAt: this.expiresAt,
      });
      while (!this.ended) {
        const request = await wire.json(4096);
        if (this.ended) throw new Error("Share expired.");
        if (request.type === "bye") {
          await wire.sendJSON({ type: "bye" });
          break;
        }
        if (request.type !== "get" || typeof request.id !== "string")
          throw new Error("Invalid file request.");
        const file = this.share.files.get(request.id);
        const entry = this.share.entries.find(
          (e) => e.id === request.id && e.kind === "file",
        );
        if (!file || !entry)
          throw new Error("This file is not part of the share.");
        await wire.sendJSON({ type: "start", id: entry.id, size: entry.size });
        const hash = sha256.create();
        for (let offset = 0; offset < file.size; offset += CHUNK) {
          if (this.ended) throw new Error("This share has ended.");
          const bytes = new Uint8Array(
            await file.slice(offset, offset + CHUNK).arrayBuffer(),
          );
          if (this.ended) throw new Error("This share has ended.");
          if (!bytes.length)
            throw new Error("The selected file is no longer readable.");
          hash.update(bytes);
          await wire.send(2, bytes);
        }
        if (this.ended) throw new Error("This share has ended.");
        await wire.sendJSON({
          type: "end",
          id: entry.id,
          sha256: bytesToHex(hash.digest()),
        });
        this.event({ type: "sent", name: entry.path, bytes: entry.size });
      }
    } catch {
      // No metadata or internal errors are disclosed before authentication.
    } finally {
      clearTimeout(authTimer);
      wire.close();
      this.connections.delete(conn);
      if (authenticated) {
        this.peers--;
        this.event({ type: "peers", count: this.peers });
        // Closing Tailcat's listener also closes its WireGuard node. Keep it
        // alive for admitted recipients, then release it when the last leaves.
        if (this.exhausted && this.peers === 0) this.expire("uses");
      }
    }
  }
}
export interface Sink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export type Progress = { entry: Entry; bytes: number; total: number };
export class ShareClient {
  private wire?: Wire;
  private busy = false;
  private stopped = false;
  manifest?: Manifest;
  constructor(private transport: Transport = tailcat) {}
  async connect(invite: Invite) {
    const conn = await this.transport.dial(invite.address);
    if (this.stopped) {
      conn.close();
      throw new Error("Connection cancelled.");
    }
    this.wire = new Wire(conn);
    const timer = setTimeout(() => this.wire?.close(), 15_000);
    try {
      await this.wire.sendJSON({
        type: "hello",
        version: 1,
        token: invite.token,
      });
      const message = await this.wire.json();
      if (message.type !== "manifest")
        throw new Error("Unexpected share response.");
      this.manifest = validateManifest(message);
      return this.manifest;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  get closed() {
    return this.stopped;
  }
  close() {
    this.stopped = true;
    this.wire?.close();
  }
  async disconnect() {
    if (!this.wire || this.stopped || this.busy) {
      this.close();
      return;
    }
    this.stopped = true;
    // Signal an idle recipient's departure before tearing down its WireGuard
    // node. TCP close alone may not reach the sender before that node disappears.
    const timer = setTimeout(() => this.wire?.close(), 1500);
    try {
      await this.wire.sendJSON({ type: "bye" });
      await this.wire.json(4096);
    } catch {
      // A stopped/offline sender cannot acknowledge; local cleanup still wins.
    } finally {
      clearTimeout(timer);
      this.close();
    }
  }
  async receive(
    entry: Entry,
    sink: Sink,
    onProgress: (p: Progress) => void = () => {},
  ) {
    if (
      !this.wire ||
      this.stopped ||
      this.busy ||
      (this.manifest !== undefined && hasExpired(this.manifest.expiresAt)) ||
      !this.manifest?.entries.some(
        (e) => e.id === entry.id && e.kind === "file",
      )
    ) {
      await sink.abort().catch(() => {});
      throw new Error("Reconnect before downloading.");
    }
    this.busy = true;
    let timer: ReturnType<typeof setTimeout>;
    const touch = (milliseconds = 120_000) => {
      clearTimeout(timer);
      timer = setTimeout(() => this.close(), milliseconds);
    };
    touch(15_000);
    const ensureLive = () => {
      if (this.stopped || hasExpired(this.manifest!.expiresAt))
        throw new Error(
          "This share expired or disconnected. Download discarded.",
        );
    };
    try {
      await this.wire.sendJSON({ type: "get", id: entry.id });
      const start = await this.wire.json(4096);
      if (
        start.type !== "start" ||
        start.id !== entry.id ||
        start.size !== entry.size
      )
        throw new Error("File metadata changed. Reconnect and try again.");
      touch();
      const hash = sha256.create();
      let bytes = 0;
      onProgress({ entry, bytes, total: entry.size });
      while (bytes < entry.size) {
        const frame = await this.wire.read();
        ensureLive();
        touch();
        if (frame.type !== 2 || bytes + frame.data.length > entry.size)
          throw new Error("Invalid file length. Download discarded.");
        bytes += frame.data.length;
        hash.update(frame.data);
        await sink.write(frame.data);
        onProgress({ entry, bytes, total: entry.size });
      }
      const end = await this.wire.json(4096);
      if (
        end.type !== "end" ||
        end.id !== entry.id ||
        end.sha256 !== bytesToHex(hash.digest())
      )
        throw new Error("File verification failed. Download discarded.");
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
