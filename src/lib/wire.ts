export interface Connection {
  port: number;
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): void;
}
export const CHUNK = 64 * 1024;
export const MAX_JSON = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export class Wire {
  private pending: Uint8Array = new Uint8Array();
  private offset = 0;
  constructor(readonly conn: Connection) {}
  private async exact(size: number): Promise<Uint8Array> {
    const result = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      if (this.offset === this.pending.length) {
        const chunk = await this.conn.read();
        if (!chunk?.length)
          throw new Error(
            "Connection closed. Ask the sender to keep their tab open and reconnect.",
          );
        if (chunk.length > CHUNK) throw new Error("Oversized transport chunk.");
        this.pending = chunk;
        this.offset = 0;
      }
      const count = Math.min(size - written, this.pending.length - this.offset);
      result.set(
        this.pending.subarray(this.offset, this.offset + count),
        written,
      );
      written += count;
      this.offset += count;
    }
    return result;
  }
  async read(
    jsonLimit = MAX_JSON,
  ): Promise<{ type: number; data: Uint8Array }> {
    const header = await this.exact(5);
    const type = header[0];
    const size = new DataView(header.buffer).getUint32(1);
    if (
      (type !== 1 && type !== 2) ||
      size === 0 ||
      size > (type === 1 ? jsonLimit : CHUNK)
    )
      throw new Error("Invalid or oversized protocol frame.");
    return { type, data: await this.exact(size) };
  }
  async json(limit = MAX_JSON): Promise<Record<string, unknown>> {
    const frame = await this.read(limit);
    if (frame.type !== 1) throw new Error("Expected control message.");
    const value = JSON.parse(decoder.decode(frame.data));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid control message.");
    if (value.type === "error")
      throw new Error(
        typeof value.message === "string"
          ? value.message.slice(0, 200)
          : "Peer rejected the request.",
      );
    return value;
  }
  async send(type: number, data: Uint8Array) {
    if (!data.length || data.length > (type === 1 ? MAX_JSON : CHUNK))
      throw new Error("Frame exceeds protocol limit.");
    const header = new Uint8Array(5);
    header[0] = type;
    new DataView(header.buffer).setUint32(1, data.length);
    if (data.length <= CHUNK) {
      // Keep the tiny header with its payload across the worker/TCP boundary.
      // Separate awaited writes add a worker round trip and can flush a tiny
      // TCP segment before the payload is available. Wire format is unchanged.
      const frame = new Uint8Array(header.length + data.length);
      frame.set(header);
      frame.set(data, header.length);
      await this.conn.write(frame);
      return;
    }
    await this.conn.write(header);
    for (let i = 0; i < data.length; i += CHUNK)
      await this.conn.write(data.subarray(i, i + CHUNK));
  }
  sendJSON(value: unknown) {
    return this.send(1, encoder.encode(JSON.stringify(value)));
  }
  close() {
    this.conn.close();
  }
}
