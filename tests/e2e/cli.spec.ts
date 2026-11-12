import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";

test("real tailcat serve: large directory tree, browse, download, ZIP, and disconnect", async ({
  page,
}, info) => {
  test.skip(
    process.env.TAILSHARE_NETWORK !== "1",
    "Requires the pinned CLI and public DERP relays.",
  );
  test.setTimeout(150_000);
  const root = info.outputPath("cli-share");
  const config = info.outputPath("cli-config");
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, "empty-folder"));
  for (let i = 0; i < 10_050; i++)
    await mkdir(join(root, "many-folders", `folder-${i}`), { recursive: true });
  await writeFile(
    join(root, "many-folders", "folder-199", "last.txt"),
    "Last folder file.",
  );
  await mkdir(join(root, "unopened", "nested"), { recursive: true });
  await writeFile(
    join(root, "unopened", "nested", "later.txt"),
    "Discovered during download.",
  );
  await mkdir(config);
  await writeFile(
    join(root, "notes", "readme.txt"),
    "Synthetic CLI file through Tailcat and SFTP.",
  );
  await writeFile(join(root, "binary.bin"), Buffer.alloc(256 * 1024, 41));
  await writeFile(join(root, "empty.txt"), "");
  const outside = info.outputPath("not-shared.txt");
  await writeFile(outside, "Synthetic unshared file");
  await symlink(outside, join(root, "skip-link.txt"));
  const sender = spawn(
    resolve("transport/.build/tailcat"),
    ["serve", "--key=new", "--files=.:ro"],
    {
      cwd: root,
      env: { ...process.env, XDG_CONFIG_HOME: config },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise<void>((done) => sender.once("exit", () => done()));
  try {
    const key = await new Promise<string>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("CLI did not publish an address in time.")),
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
      sender.stdout.on("data", scan);
      sender.stderr.on("data", scan);
      sender.once("error", () => {
        clearTimeout(timer);
        fail(new Error("Build the pinned CLI with npm run build:test-cli."));
      });
      sender.once("exit", () => {
        clearTimeout(timer);
        fail(new Error("CLI exited before connecting."));
      });
    });
    await page.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      });
    });
    const errors: string[] = [];
    const requests: string[] = [];
    const downloads: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    page.on("download", (download) =>
      downloads.push(download.suggestedFilename()),
    );
    await page.goto("/");
    await page
      .getByRole("button", { name: "Receive files", exact: true })
      .click();
    if (
      info.project.name === "chromium" ||
      info.project.name === "mobile-safari"
    ) {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `.impeccable/review/cli-entry-${info.project.name}.png`,
        fullPage: true,
      });
    }
    await page.getByLabel("Share link or key").fill(key);
    await page.getByRole("button", { name: "Connect to sender" }).click();
    await expect(
      page.getByText("Connected to CLI share.", { exact: false }),
    ).toBeVisible({ timeout: 65_000 });
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(downloads).toEqual([]);
    await expect(page.getByText("skip-link.txt", { exact: true })).toBeHidden();
    await expect(
      page.getByText("Symbolic links and special files skipped: 1.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("You’re browsing a Tailcat CLI share.", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "empty-folder", exact: true })
      .click();
    await expect(page.getByText("This folder is empty.")).toBeVisible();
    await page
      .getByRole("button", { name: "Shared files", exact: true })
      .click();
    await page.getByRole("button", { name: "notes", exact: true }).click();
    if (
      info.project.name === "chromium" ||
      info.project.name === "mobile-safari"
    ) {
      await page.screenshot({
        path: `.impeccable/review/cli-connected-${info.project.name}.png`,
        fullPage: true,
      });
    }
    const one = page.waitForEvent("download");
    await page.getByLabel("Download readme.txt", { exact: true }).click();
    expect(await readFile((await (await one).path())!, "utf8")).toBe(
      "Synthetic CLI file through Tailcat and SFTP.",
    );
    await expect(
      page.getByText("File downloaded.", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Shared files", exact: true })
      .click();
    await page
      .getByRole("button", { name: "many-folders", exact: true })
      .click();
    await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Next page", exact: true }),
    ).toBeEnabled();
    const fileRows = page.locator(".file-rows");
    const scrollListToEnd = async () => {
      await fileRows.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() => fileRows.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
    };
    const expectListAtStart = () =>
      expect
        .poll(() => fileRows.evaluate((element) => element.scrollTop))
        .toBe(0);
    await scrollListToEnd();
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    await expectListAtStart();
    await expect(page.getByRole("row")).toHaveCount(101); // Tailcat returns 100 names per packet.
    await page.getByLabel("Filter this page").fill("not-a-file-name");
    await expect(page.getByText("No files match your search.")).toBeVisible();
    await page.getByLabel("Filter this page").fill("");
    if (
      info.project.name === "chromium" ||
      info.project.name === "mobile-safari"
    ) {
      await page.screenshot({
        path: `.impeccable/review/cli-paged-${info.project.name}.png`,
        fullPage: true,
      });
    }
    await scrollListToEnd();
    await page
      .getByRole("button", { name: "Previous page", exact: true })
      .click();
    await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
    await expectListAtStart();
    await scrollListToEnd();
    await page
      .getByRole("button", { name: "Refresh folder", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Previous page", exact: true }),
    ).toBeDisabled();
    await expectListAtStart();
    await page
      .getByRole("button", { name: "Shared files", exact: true })
      .click();
    // Keep the full-share ZIP fixture small; the large folder tests browsing.
    await rm(join(root, "many-folders"), { recursive: true });
    await page
      .getByRole("button", { name: "Refresh folder", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "many-folders", exact: true }),
    ).toBeHidden();
    const zip = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download all as ZIP" }).click();
    const files = unzipSync(await readFile((await (await zip).path())!));
    expect(files["binary.bin"]).toEqual(new Uint8Array(256 * 1024).fill(41));
    expect(files["empty.txt"].length).toBe(0);
    expect(files["empty-folder/"]).toBeDefined();
    expect(new TextDecoder().decode(files["unopened/nested/later.txt"])).toBe(
      "Discovered during download.",
    );
    expect(files["skip-link.txt"]).toBeUndefined();
    expect(requests.some((url) => url.includes(key))).toBe(false);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByLabel("Share link or key")).toHaveValue("");
    if (
      info.project.name === "chromium" ||
      info.project.name === "mobile-safari"
    ) {
      await page.getByText("How your files travel", { exact: true }).click();
      await page.screenshot({
        path: `.impeccable/review/cli-recovery-${info.project.name}.png`,
        fullPage: true,
      });
    }
  } finally {
    sender.kill("SIGTERM");
    const force = setTimeout(() => sender.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  }
});
