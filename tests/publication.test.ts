import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checker = fileURLToPath(
  new URL("../scripts/check-dist.mjs", import.meta.url),
);
let root: string;

async function put(name: string, value: string | Uint8Array = "") {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function check() {
  return execFileSync(process.execPath, [checker, root], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tailshare-publication-test-"));
  await put(
    "index.html",
    '<meta http-equiv="Content-Security-Policy" content="script-src \'self\' \'wasm-unsafe-eval\'"><script src="./assets/index-12345678.js"></script>',
  );
  for (const name of [
    ".nojekyll",
    "_headers",
    "favicon.svg",
    "THIRD_PARTY_LICENSES.txt",
    "transport/LICENSE.go",
    "assets/index-12345678.js",
    "assets/index-12345678.css",
    "assets/example-font-12345678.woff2",
  ])
    await put(name);
  const compressed = gzipSync(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const version = createHash("sha256")
    .update(compressed)
    .digest("hex")
    .slice(0, 16);
  await put(`transport/tailcat-${version}.wasm.gz`, compressed);
  await put(`transport/wasm_exec-${version}.js`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("publication boundary", () => {
  it("accepts the static site, transport, and bundled font assets", () => {
    expect(check()).toContain("approved files only");
  });
  it("rejects mismatched runtime/WASM pairs even under approved file names", async () => {
    const name = (await readdir(join(root, "transport"))).find((name) =>
      name.startsWith("wasm_exec-"),
    )!;
    await put("transport/" + name, "synthetic runtime from another build");
    expect(check).toThrow(/does not match its version/);
  });
  it.each([
    ".env",
    "transport/private.key",
    "photos/personal.jpg",
    "assets/index-12345678.js.map",
    ".git/config",
  ])("rejects an unexpected deploy artifact: %s", async (name) => {
    await put(name, "synthetic fixture");
    expect(check).toThrow(/Unexpected deployment (file|directory)/);
  });
  it("rejects symlinks even when the file name is approved", async () => {
    await rm(join(root, "favicon.svg"));
    await symlink(join(root, "index.html"), join(root, "favicon.svg"));
    expect(check).toThrow(/symlinks/);
  });
});
