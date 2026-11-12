import { test, expect, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";

async function inbox(info: TestInfo, tree: boolean) {
  const root = info.outputPath(tree ? "tree-inbox" : "flat-inbox");
  const config = info.outputPath(tree ? "tree-config" : "flat-config");
  await mkdir(root, { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(
    join(root, "binary.bin"),
    "Synthetic existing file: do not replace.",
  );
  const proc = spawn(
    resolve("transport/.build/tailcat"),
    ["recv", "--key=new", ...(tree ? ["--accept-dirs"] : []), root],
    {
      env: { ...process.env, XDG_CONFIG_HOME: config },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise<void>((done) => proc.once("exit", () => done()));
  const stop = async () => {
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  };
  try {
    const key = await new Promise<string>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("CLI receiver did not start in time.")),
        45_000,
      );
      let buffer = "";
      const scan = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-8192);
        const match = buffer.match(/\btc[A-Za-z0-9_-]{20,2048}\b/);
        if (match) {
          clearTimeout(timer);
          done(match[0]);
        }
      };
      proc.stdout.on("data", scan);
      proc.stderr.on("data", scan);
      proc.once("error", () => {
        clearTimeout(timer);
        fail(new Error("Build the pinned CLI before running relay tests."));
      });
      proc.once("exit", () => {
        clearTimeout(timer);
        fail(new Error("CLI receiver exited before connecting."));
      });
    });
    return { root, key, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test("real tailcat recv: browser sends separate files, ZIP, and folder trees", async ({
  page,
}, info) => {
  test.skip(
    process.env.TAILSHARE_NETWORK !== "1",
    "Requires the pinned CLI and public DERP relays.",
  );
  const flat = await inbox(info, false);
  let tree: Awaited<ReturnType<typeof inbox>> | undefined;
  try {
    const sample = info.outputPath("selection");
    await mkdir(join(sample, "notes"), { recursive: true });
    await writeFile(
      join(sample, "notes/readme.txt"),
      "Synthetic browser upload over Tailcat SFTP.",
    );
    await writeFile(join(sample, "binary.bin"), Buffer.alloc(256 * 1024, 47));
    await writeFile(join(sample, "empty.txt"), "");
    const errors: string[] = [],
      requests: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => requests.push(r.url()));
    await page.goto("/");
    await page
      .getByRole("combobox", { name: "Send to", exact: true })
      .selectOption("cli");
    await page.getByLabel("Choose folder to share").setInputFiles(sample);
    const capture = async (state: string) => {
      if (
        info.project.name === "chromium" ||
        info.project.name === "mobile-safari"
      ) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: `.impeccable/review/cli-send-${state}-${info.project.name}.png`,
          fullPage: true,
        });
      }
    };
    await capture("ready");
    await expect(page.getByLabel("Link & key expiry")).toBeHidden();
    const send = page.getByRole("button", { name: "Send to CLI", exact: true });
    await expect(send).toBeDisabled();
    await page.getByLabel("CLI receiver key").fill(flat.key);
    expect(await readdir(flat.root)).toEqual(["binary.bin"]); // Pasting a key never sends.
    await send.click();
    await expect(page.getByText("3 files sent.", { exact: false })).toBeVisible(
      { timeout: 65_000 },
    );
    await expect(page.getByLabel("CLI receiver key")).toHaveValue("");
    const names = await readdir(flat.root);
    expect(names).toHaveLength(4);
    const binary = names.find(
      (n) => n.startsWith("binary.") && n !== "binary.bin",
    )!;
    expect(await readFile(join(flat.root, binary))).toEqual(
      Buffer.alloc(256 * 1024, 47),
    );
    expect(
      (
        await readFile(
          join(flat.root, names.find((n) => n.startsWith("empty."))!),
        )
      ).length,
    ).toBe(0);
    expect(await readFile(join(flat.root, "binary.bin"), "utf8")).toBe(
      "Synthetic existing file: do not replace.",
    );
    await page
      .getByRole("combobox", { name: "Send as", exact: true })
      .selectOption("zip");
    await page.getByLabel("CLI receiver key").fill(flat.key);
    await send.click();
    await expect(page.getByText("ZIP sent.", { exact: false })).toBeVisible({
      timeout: 65_000,
    });
    const zipName = (await readdir(flat.root)).find((n) => n.endsWith(".zip"))!;
    const zip = unzipSync(await readFile(join(flat.root, zipName)));
    expect(zip["selection/binary.bin"]).toEqual(
      new Uint8Array(256 * 1024).fill(47),
    );
    expect(zip["selection/empty.txt"].length).toBe(0);
    await page
      .getByRole("combobox", { name: "Send as", exact: true })
      .selectOption("tree");
    await page.getByLabel("CLI receiver key").fill(flat.key);
    await send.click();
    await expect(page.getByRole("alert")).toContainText("--accept-dirs", {
      timeout: 65_000,
    });
    tree = await inbox(info, true);
    await page.getByLabel("CLI receiver key").fill(tree.key);
    await send.click();
    await expect(
      page.getByText("Transfer complete.", { exact: false }),
    ).toBeVisible({ timeout: 65_000 });
    const folder = (await readdir(tree.root)).find((n) =>
      n.startsWith("TailShare-"),
    )!;
    expect(
      await readFile(join(tree.root, folder, "selection/binary.bin")),
    ).toEqual(Buffer.alloc(256 * 1024, 47));
    expect(
      await readFile(
        join(tree.root, folder, "selection/notes/readme.txt"),
        "utf8",
      ),
    ).toContain("Synthetic browser upload");
    await capture("complete");
    expect(
      requests.some((url) => url.includes(flat.key) || url.includes(tree!.key)),
    ).toBe(false);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await flat.stop();
    await tree?.stop();
  }
});

test("CLI upload cancellation closes the transfer and explains partial files", async ({
  page,
}, info) => {
  test.skip(
    process.env.TAILSHARE_NETWORK !== "1",
    "Requires the pinned CLI and public DERP relays.",
  );
  const receiver = await inbox(info, false);
  try {
    await page.goto("/");
    await page
      .getByRole("combobox", { name: "Send to", exact: true })
      .selectOption("cli");
    await page
      .getByLabel("Choose files to share")
      .setInputFiles({
        name: "cancel.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.alloc(1024 * 1024, 37),
      });
    // Pause after one bounded SFTP batch, then cancel while the source is backpressured.
    await page.evaluate(() => {
      const w = window as unknown as {
        uploadPaused: boolean;
        resumeTestUpload: () => void;
        tailshareCLIUpload?: (...args: unknown[]) => Promise<void>;
      };
      w.uploadPaused = false;
      const poll = setInterval(() => {
        if (!w.tailshareCLIUpload) return;
        clearInterval(poll);
        const original = w.tailshareCLIUpload;
        w.tailshareCLIUpload = async (...args) => {
          await original(...args);
          if (args[1] === "write") {
            w.uploadPaused = true;
            await new Promise<void>((resolve) => {
              w.resumeTestUpload = resolve;
            });
          }
        };
      }, 5);
    });
    await page.getByLabel("CLI receiver key").fill(receiver.key);
    await page
      .getByRole("button", { name: "Send to CLI", exact: true })
      .click();
    await page.waitForFunction(
      () => (window as unknown as { uploadPaused: boolean }).uploadPaused,
      null,
      { timeout: 65_000 },
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByText("Transfer stopped.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Completed and partial files may remain", {
        exact: false,
      }),
    ).toBeVisible();
    await page.evaluate(() =>
      (
        window as unknown as { resumeTestUpload: () => void }
      ).resumeTestUpload(),
    );
    await expect(page.getByLabel("CLI receiver key")).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Send to CLI", exact: true }),
    ).toBeDisabled();
    const partial = (await readdir(receiver.root)).find((n) =>
      n.startsWith("cancel."),
    )!;
    expect((await readFile(join(receiver.root, partial))).length).toBe(262144);
  } finally {
    await receiver.stop();
  }
});
