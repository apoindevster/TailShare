import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const wasm = await readFile(new URL("transport/.build/tailcat.wasm.gz", root));
const runtime = await readFile(new URL("transport/.build/wasm_exec.js", root));
// Both URLs change together. A cached application always requests its matching pair.
const version = createHash("sha256")
  .update(wasm)
  .update(runtime)
  .digest("hex")
  .slice(0, 16);
const assets = {
  version,
  wasm: `transport/tailcat-${version}.wasm.gz`,
  runtime: `transport/wasm_exec-${version}.js`,
};
const directory = new URL("public/transport/", root);
for (const name of await readdir(directory)) {
  if (
    /^(?:tailcat(?:-[a-f0-9]{16})?\.wasm\.gz|wasm_exec(?:-[a-f0-9]{16})?\.js)$/.test(
      name,
    )
  )
    await rm(new URL(name, directory));
}
await writeFile(new URL("public/" + assets.wasm, root), wasm);
await writeFile(new URL("public/" + assets.runtime, root), runtime);
await writeFile(
  new URL("transport/.build/assets.json", root),
  JSON.stringify(assets),
);
console.log(`Versioned transport assets: ${version}`);
