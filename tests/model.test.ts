import { describe, expect, it } from "vitest";
import { File } from "node:buffer";
import {
  createShare,
  childrenOf,
  inviteKey,
  inviteLink,
  parseInvite,
  safePath,
  validateManifest,
  shareToken,
} from "../src/lib/model";
const file = (name: string, content = "hello", path?: string) => {
  const f = new File([content], name, {
    lastModified: 1,
  }) as unknown as globalThis.File;
  if (path) Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
};
describe("sharing boundaries", () => {
  it("creates a navigable tree without exposing filesystem paths", () => {
    const s = createShare(
      [file("note.txt", "hello", "mix/notes/note.txt"), file("mix.wav")],
      ["empty"],
    );
    expect(childrenOf(s.entries, "").map((e) => e.path)).toEqual([
      "empty",
      "mix",
      "mix.wav",
    ]);
    expect(childrenOf(s.entries, "mix/notes")[0].path).toBe(
      "mix/notes/note.txt",
    );
    expect(s.files.size).toBe(2);
  });
  it.each([
    "../secrets",
    "/etc/passwd",
    "a/../../x",
    "a\\b",
    "a//b",
    "a/./b",
    "C:foo",
    "x\u0000.txt",
    "x\u202efile",
    "CON.txt",
    "dir/nul",
    "foo.",
    "foo ",
    "aux/hi",
  ])("rejects unsafe path %s", (path) => {
    expect(() => safePath(path)).toThrow();
  });
  it("rejects duplicate and case-colliding paths", () => {
    expect(() => createShare([file("A.txt"), file("a.txt")])).toThrow(
      /Duplicate/,
    );
  });
  it("rejects file/directory conflicts", () => {
    expect(() =>
      createShare([file("foo"), file("bar", "data", "foo/bar")]),
    ).toThrow();
  });
  it("rejects untrusted lengths, missing parents, and expired manifests", () => {
    const e = {
      id: "x",
      path: "dir/file.txt",
      kind: "file",
      size: -1,
      modified: 1,
    };
    expect(() =>
      validateManifest({
        version: 1,
        entries: [e],
        expiresAt: Date.now() + 1000,
      }),
    ).toThrow();
    expect(() =>
      validateManifest({
        version: 1,
        entries: [{ ...e, size: 1 }],
        expiresAt: Date.now() + 1000,
      }),
    ).toThrow(/tree/);
    expect(() =>
      validateManifest({ version: 1, entries: [], expiresAt: 1 }),
    ).toThrow(/expired/);
  });
  it("limits manifest size before iterating", () => {
    expect(() =>
      validateManifest({
        version: 1,
        entries: new Array(10001),
        expiresAt: Date.now() + 1000,
      }),
    ).toThrow();
  });
  it("accepts an explicit no-deadline manifest", () => {
    expect(
      validateManifest({ version: 1, entries: [], expiresAt: null }).expiresAt,
    ).toBeNull();
  });
  it.each([undefined, "never", Infinity, NaN, 0, -1])(
    "rejects malformed expiry %s",
    (expiresAt) => {
      expect(() =>
        validateManifest({ version: 1, entries: [], expiresAt }),
      ).toThrow();
    },
  );
});
describe("capability links", () => {
  const invite = { address: "tc" + "a".repeat(100), token: "a".repeat(64) };
  it("uses fragments only and removes query parameters", () => {
    const link = inviteLink(
      invite,
      "https://example.com/share/?tracking=hi#old",
    );
    expect(new URL(link).search).toBe("");
    expect(parseInvite(link)).toEqual(invite);
    expect(parseInvite(inviteKey(invite))).toEqual(invite);
  });
  it("rejects missing, short, query-string, or arbitrary URL credentials", () => {
    for (const s of [
      "tc123",
      "javascript:alert(1)",
      "https://host/?" + inviteKey(invite),
      inviteKey({ ...invite, token: "short" }),
    ])
      expect(() => parseInvite(s)).toThrow();
  });
  it("generates independent 256-bit access tokens", () => {
    expect(shareToken()).toMatch(/^[a-f0-9]{64}$/);
    expect(shareToken()).not.toBe(shareToken());
  });
});

// Entry count alone does not bound metadata when a share has long nested names.
it("rejects a locally selected tree whose manifest cannot fit on the wire", () => {
  const prefix = Array.from(
    { length: 5 },
    (_, i) => String(i) + "a".repeat(149),
  ).join("/");
  const files = Array.from({ length: 6000 }, (_, i) =>
    file(`file-${i}`, "", `${prefix}/file-${i}`),
  );
  expect(() => createShare(files)).toThrow(/metadata limit/);
});
