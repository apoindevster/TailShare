import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const packages = [
  "react",
  "react-dom",
  "fflate",
  "@noble/hashes",
  "lucide-react",
  "@fontsource/chakra-petch",
  "@fontsource/ibm-plex-sans",
];
const notices = await Promise.all(
  packages.map(
    async (name) =>
      `${name}\n${"-".repeat(name.length)}\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}`,
  ),
);
notices.push(
  `Tailcat\n-------\n${await readFile("transport/LICENSE.tailcat", "utf8")}`,
);
notices.push(
  `Go runtime\n----------\n${await readFile("public/transport/LICENSE.go", "utf8")}`,
);
for (const name of [
  "github.com/pkg/sftp",
  "golang.org/x/crypto",
  "golang.org/x/text",
]) {
  const directory = execFileSync("go", ["list", "-m", "-f", "{{.Dir}}", name], {
    cwd: "transport",
    encoding: "utf8",
  }).trim();
  notices.push(
    `${name}\n${"-".repeat(name.length)}\n${await readFile(join(directory, "LICENSE"), "utf8")}`,
  );
}
await mkdir("public", { recursive: true });
await writeFile("public/THIRD_PARTY_LICENSES.txt", notices.join("\n\n"));
