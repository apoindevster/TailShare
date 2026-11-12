import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]) + sep)
  : new URL("../dist/", import.meta.url);
const rootPath = fileURLToPath(root);
// Vite copies every public/ file, even files excluded by .gitignore. Require an
// explicit review here before any new public asset can reach a deployment.
const publicFiles = new Set([
  "index.html",
  ".nojekyll",
  "_headers",
  "favicon.svg",
  "THIRD_PARTY_LICENSES.txt",
  "transport/LICENSE.go",
]);
const transportFiles = await readdir(new URL("transport/", root));
const wasmFiles = transportFiles.filter((name) =>
  /^tailcat-[a-f0-9]{16}\.wasm\.gz$/.test(name),
);
assert.equal(wasmFiles.length, 1, "Expected one versioned WASM asset");
const wasmName = wasmFiles[0];
const version = wasmName.slice(8, 24);
const runtimeName = `wasm_exec-${version}.js`;
const compressed = await readFile(new URL("transport/" + wasmName, root));
const runtime = await readFile(new URL("transport/" + runtimeName, root));
assert.equal(
  createHash("sha256")
    .update(compressed)
    .update(runtime)
    .digest("hex")
    .slice(0, 16),
  version,
  "Transport pair does not match its version",
);
publicFiles.add("transport/" + wasmName);
publicFiles.add("transport/" + runtimeName);
const html = await readFile(new URL("index.html", root), "utf8");
assert(
  html.includes("wasm-unsafe-eval"),
  "Production CSP must permit WebAssembly",
);
assert(
  html.includes('http-equiv="Content-Security-Policy"'),
  "Production CSP is missing",
);
assert(
  !/\b(?:src|href)="\/(?!\/)/.test(html),
  "Root-relative assets break GitHub project Pages",
);
for (const file of [
  ".nojekyll",
  "_headers",
  "transport/LICENSE.go",
  "THIRD_PARTY_LICENSES.txt",
])
  await stat(new URL(file, root));
const wasm = gunzipSync(compressed);
assert.deepEqual(
  [...wasm.subarray(0, 8)],
  [0, 97, 115, 109, 1, 0, 0, 0],
  "Invalid WASM binary",
);
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(
      !entry.isSymbolicLink(),
      "Deployment artifacts must not include symlinks",
    );
    const path = join(directory, entry.name);
    const name = relative(rootPath, path).split(sep).join("/");
    if (entry.isDirectory()) {
      assert(
        name === "assets" || name === "transport",
        `Unexpected deployment directory: ${name}`,
      );
      await checkDirectory(path);
    } else {
      assert(entry.isFile(), `Deployment artifact must be a file: ${name}`);
      assert(
        publicFiles.has(name) ||
          /^assets\/[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(
            name,
          ),
        `Unexpected deployment file: ${name}`,
      );
      assert(
        (await stat(path)).size <= 25 * 1024 * 1024,
        `Cloudflare Pages asset exceeds 25 MiB: ${entry.name}`,
      );
    }
  }
}
await checkDirectory(rootPath);
console.log(
  "Static bundle verified: approved files only, relative assets, CSP, licenses, WASM, and Pages file-size limits.",
);
