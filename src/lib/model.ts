import { MAX_JSON } from "./wire";
export const MAX_ENTRIES = 10_000;
export const MEMORY_LIMIT = 256 * 1024 * 1024;
export const ZIP_LIMIT = 4_000_000_000;
export const MAX_SHARE_USES = 1000;
export type SharePolicy = { minutes: number | null; maxUses: number | null };
export const hasExpired = (expiresAt: number | null) =>
  expiresAt !== null && Date.now() >= expiresAt;
export type Entry = {
  id: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modified: number;
};
export type Manifest = {
  version: 1;
  entries: Entry[];
  expiresAt: number | null;
};
export type LocalShare = { entries: Entry[]; files: Map<string, File> };

export function safePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value !== value.normalize("NFC")
  )
    throw new Error("Invalid file path.");
  const parts = value.split("/");
  if (
    parts.length > 32 ||
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        p.length > 255 ||
        /[\\<>:"|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
          p,
        ) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error(
      "A file name is unsafe on another device. Rename it and try again.",
    );
  return value;
}

export function validateManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== "object")
    throw new Error("Invalid share manifest.");
  const m = raw as Manifest;
  if (
    m.version !== 1 ||
    !Array.isArray(m.entries) ||
    m.entries.length > MAX_ENTRIES ||
    (m.expiresAt !== null &&
      (!Number.isSafeInteger(m.expiresAt) || hasExpired(m.expiresAt)))
  )
    throw new Error("The share is invalid or has expired.");
  const ids = new Set<string>();
  const paths = new Map<string, Entry>();
  let total = 0;
  const entries = m.entries.map((e) => {
    if (
      !e ||
      typeof e !== "object" ||
      typeof e.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(e.id) ||
      ids.has(e.id) ||
      !["file", "directory"].includes(e.kind) ||
      !Number.isSafeInteger(e.size) ||
      e.size < 0 ||
      (e.kind === "directory" && e.size !== 0) ||
      !Number.isSafeInteger(e.modified) ||
      e.modified < 0
    )
      throw new Error("Invalid file metadata.");
    const path = safePath(e.path);
    const key = path.toLowerCase();
    if (paths.has(key))
      throw new Error("Duplicate file paths are not supported.");
    const entry: Entry = {
      id: e.id,
      path,
      kind: e.kind,
      size: e.size,
      modified: e.modified,
    };
    ids.add(e.id);
    paths.set(key, entry);
    total += e.size;
    if (!Number.isSafeInteger(total))
      throw new Error("This share is too large.");
    return entry;
  });
  for (const e of entries) {
    const parts = e.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++)
      if (paths.get(parts.slice(0, i).join("/"))?.kind !== "directory")
        throw new Error("Invalid directory tree.");
  }
  return { version: 1, entries, expiresAt: m.expiresAt };
}

export function createShare(
  files: Iterable<File>,
  directories: string[] = [],
): LocalShare {
  const entries: Entry[] = [];
  const content = new Map<string, File>();
  const paths = new Set<string>();
  const addDirectory = (path: string) => {
    const parts = safePath(path.normalize("NFC")).split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!paths.has(p)) {
        entries.push({
          id: crypto.randomUUID(),
          path: p,
          kind: "directory",
          size: 0,
          modified: 0,
        });
        paths.add(p);
      }
    }
  };
  for (const d of directories) addDirectory(d);
  for (const file of files) {
    const path = safePath(
      (file.webkitRelativePath || file.name).normalize("NFC"),
    );
    if (path.includes("/")) addDirectory(path.slice(0, path.lastIndexOf("/")));
    const entry: Entry = {
      id: crypto.randomUUID(),
      path,
      kind: "file",
      size: file.size,
      modified: Math.max(0, file.lastModified),
    };
    entries.push(entry);
    content.set(entry.id, file);
    if (entries.length > MAX_ENTRIES)
      throw new Error(
        `Choose at most ${MAX_ENTRIES.toLocaleString()} files and folders.`,
      );
  }
  const manifest = { version: 1, entries, expiresAt: Date.now() + 1000 };
  validateManifest(manifest);
  if (new TextEncoder().encode(JSON.stringify(manifest)).length > MAX_JSON - 64)
    throw new Error(
      "These file names exceed the sharing metadata limit. Select fewer files.",
    );
  return { entries, files: content };
}

export function childrenOf(entries: Entry[], directory: string) {
  const prefix = directory ? directory + "/" : "";
  return entries
    .filter(
      (e) =>
        e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/"),
    )
    .sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
        a.path.localeCompare(b.path),
    );
}
export function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export function fileName(path: string) {
  return path.split("/").at(-1)!;
}
export function shareToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export type Invite = { address: string; token: string };
export type ReceiveKey =
  | { kind: "cli"; address: string }
  | { kind: "browser"; invite: Invite };
export function parseReceiveKey(value: string): ReceiveKey {
  const text = value.trim();
  if (/^tc[a-zA-Z0-9_-]{20,2048}$/.test(text))
    return { kind: "cli", address: text };
  // A damaged TailShare invitation must never downgrade to CLI authentication.
  try {
    return { kind: "browser", invite: parseInvite(text) };
  } catch {
    throw new Error(
      "Paste a complete TailShare link or share key, or the tc… key from tailcat serve files.",
    );
  }
}
export function parseInvite(input: string): Invite {
  const trimmed = input.trim();
  if (trimmed.length > 4096) throw new Error("Invalid share key.");
  let params: URLSearchParams;
  if (/^https?:\/\//.test(trimmed))
    params = new URLSearchParams(new URL(trimmed).hash.slice(1));
  else params = new URLSearchParams(trimmed.replace(/^#/, ""));
  const address = params.get("share") ?? "";
  const token = params.get("key") ?? "";
  if (
    !/^tc[a-zA-Z0-9_-]{20,2048}$/.test(address) ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new Error("Paste a complete TailShare link or share key.");
  return { address, token };
}
export function inviteKey(invite: Invite) {
  return new URLSearchParams({
    share: invite.address,
    key: invite.token,
  }).toString();
}
export function inviteLink(invite: Invite, base = window.location.href) {
  const url = new URL(base);
  url.search = "";
  url.hash = inviteKey(invite);
  return url.href;
}
