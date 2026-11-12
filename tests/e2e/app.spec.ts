import { test, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";

test("selection, safe rendering, invalid links, and responsive layout", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your files. Their browser." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create share link", exact: true }),
  ).toBeDisabled();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([
      {
        name: "neon-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic TailShare test file"),
      },
      {
        name: "mix.wav",
        mimeType: "audio/wav",
        buffer: Buffer.from([1, 2, 3]),
      },
    ]);
  await expect(page.getByText("neon-notes.txt", { exact: true })).toBeVisible();
  await page.getByLabel("Search this folder").fill("neon");
  await expect(page.getByText("mix.wav", { exact: true })).toBeHidden();
  await page.getByLabel("Search this folder").fill("");
  await page.getByLabel("Remove mix.wav").click();
  await expect(page.getByText("mix.wav", { exact: true })).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Clear selection" }).click();
  await page
    .getByRole("button", { name: "Receive files", exact: true })
    .click();
  await page.getByLabel("Share link or key").fill("not a valid invitation");
  await page.getByRole("button", { name: "Connect to sender" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Paste a complete TailShare",
  );
  expect(errors).toEqual([]);
});

test("desktop and mobile design evidence", async ({ page }, info) => {
  test.skip(info.project.name !== "chromium", "One batched visual inspection.");
  await mkdir(".impeccable/review", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: ".impeccable/review/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".impeccable/review/mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("real Tailcat WASM: link confirmation, key-only browsing, downloads, revocation", async ({
  browser,
  page,
}, info) => {
  test.skip(
    process.env.TAILSHARE_NETWORK !== "1",
    "Set TAILSHARE_NETWORK=1 to use public DERP relays with synthetic test files.",
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const fixture = info.outputPath("sample-share");
  await mkdir(join(fixture, "notes"), { recursive: true });
  await writeFile(
    join(fixture, "notes", "readme.txt"),
    "Hello through real Tailcat WASM.",
  );
  await writeFile(join(fixture, "binary.bin"), Buffer.alloc(256 * 1024, 42));
  await writeFile(join(fixture, "empty.txt"), "");
  await page.goto("/");
  await page.locator("input[webkitdirectory]").setInputFiles(fixture);
  await page
    .getByRole("button", { name: "Create share link", exact: true })
    .click();
  await expect(
    page.getByLabel("Private share link", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  const link = await page
    .getByLabel("Private share link", { exact: true })
    .inputValue();
  const context = await browser.newContext({
    ...info.project.use,
    acceptDownloads: true,
  });
  // Exercise the fallback used by Firefox, Safari, and mobile without a native picker dialog.
  await context.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    });
  });
  const recipient = await context.newPage();
  recipient.on("pageerror", (e) => errors.push(e.message));
  const requests: string[] = [];
  const downloads: string[] = [];
  recipient.on("request", (request) => requests.push(request.url()));
  recipient.on("download", (download) =>
    downloads.push(download.suggestedFilename()),
  );
  try {
    await recipient.goto(link);
    const prompt = recipient.getByRole("dialog", {
      name: "Download this share?",
    });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await expect(prompt).toContainText("3 files (256 KB)");
    await expect(prompt.getByRole("listitem")).toHaveCount(3);
    await expect(prompt).toContainText("sample-share/notes/readme.txt");
    await expect(prompt).toContainText("sample-share/binary.bin");
    await expect(prompt).toContainText("sample-share/empty.txt");
    await expect(prompt.getByLabel("Save files as")).toHaveValue("zip");
    for (let i = 0; i < 8; i++) {
      await recipient.keyboard.press("Tab");
      expect(
        await prompt.evaluate(
          (element) =>
            // Browsers can move focus to their chrome (reported as body), but
            // the native modal must never focus a background application control.
            element.contains(document.activeElement) ||
            document.activeElement === document.body,
        ),
      ).toBe(true);
    }
    expect(
      await prompt.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    if (
      info.project.name === "chromium" ||
      info.project.name === "mobile-safari"
    ) {
      await recipient.screenshot({
        path: `.impeccable/review/download-prompt-${info.project.name}.png`,
      });
    }
    // A manifest can be inspected without downloading file data or saving anything.
    expect(downloads).toEqual([]);
    expect(new URL(recipient.url()).hash).toBe("");
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("key")!;
    expect(requests.some((url) => url.includes(token))).toBe(false);
    const linkDownload = recipient.waitForEvent("download");
    await prompt.getByRole("button", { name: "Download all files" }).click();
    const linkedZip = await linkDownload;
    expect(linkedZip.suggestedFilename()).toBe("TailShare.zip");
    const linkedArchive = unzipSync(await readFile((await linkedZip.path())!));
    expect(strFromU8(linkedArchive["sample-share/notes/readme.txt"])).toBe(
      "Hello through real Tailcat WASM.",
    );
    expect(linkedArchive["sample-share/binary.bin"]).toEqual(
      new Uint8Array(256 * 1024).fill(42),
    );
    expect(linkedArchive["sample-share/empty.txt"].length).toBe(0);
    await expect(prompt).toBeHidden();
    await expect(
      recipient.getByText("Files verified.", { exact: false }),
    ).toBeVisible();

    // Pasting a full link has the same prompt; declining leaves browsing available.
    await recipient
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await recipient.getByLabel("Share link or key").fill(link);
    await recipient.getByRole("button", { name: "Connect to sender" }).click();
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await recipient.keyboard.press("Escape");
    await expect(prompt).toBeHidden();
    await expect(
      recipient.getByRole("button", { name: "sample-share", exact: true }),
    ).toBeVisible();
    expect(downloads).toEqual(["TailShare.zip"]);

    // A raw key connects without prompting or starting any download.
    await recipient
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await recipient
      .getByLabel("Share link or key")
      .fill(new URL(link).hash.slice(1));
    await recipient.getByRole("button", { name: "Connect to sender" }).click();
    await expect(
      recipient.getByText("Connected. Choose what you want to download."),
    ).toBeVisible({ timeout: 60_000 });
    await expect(prompt).toBeHidden();
    expect(downloads).toEqual(["TailShare.zip"]);
    await recipient
      .getByRole("button", { name: "sample-share", exact: true })
      .click();
    await recipient.getByRole("button", { name: "notes", exact: true }).click();
    const singleDownload = recipient.waitForEvent("download");
    await recipient.getByLabel("Download readme.txt", { exact: true }).click();
    const single = await singleDownload;
    expect(await readFile((await single.path())!, "utf8")).toBe(
      "Hello through real Tailcat WASM.",
    );
    const zipDownload = recipient.waitForEvent("download");
    await recipient
      .getByRole("button", { name: "Download all as ZIP" })
      .click();
    const zip = await zipDownload;
    const archive = unzipSync(await readFile((await zip.path())!));
    expect(strFromU8(archive["sample-share/notes/readme.txt"])).toBe(
      "Hello through real Tailcat WASM.",
    );
    expect(archive["sample-share/binary.bin"]).toEqual(
      new Uint8Array(256 * 1024).fill(42),
    );
    expect(archive["sample-share/empty.txt"].length).toBe(0);
    await page.getByRole("button", { name: "Stop sharing" }).click();
    await expect(
      page.getByLabel("Private share link", { exact: true }),
    ).toBeHidden();
    await recipient.getByLabel("Download readme.txt", { exact: true }).click();
    await expect(recipient.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("real Tailcat WASM: link downloads separate files or a single original file", async ({
  browser,
  page,
}, info) => {
  test.skip(
    process.env.TAILSHARE_NETWORK !== "1",
    "Requires public DERP relays.",
  );
  const context = await browser.newContext({
    ...info.project.use,
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    });
  });
  const recipient = await context.newPage();
  const fixture = [
    {
      name: "first.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("First file"),
    },
    {
      name: "second.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Second file"),
    },
  ];
  try {
    await page.goto("/");
    for (const count of [2, 1]) {
      if (count === 1)
        await page.getByLabel("Link & key expiry").selectOption("never");
      await page
        .getByLabel("Choose files to share", { exact: true })
        .setInputFiles(fixture.slice(0, count));
      await page
        .getByRole("button", { name: "Create share link", exact: true })
        .click();
      const linkField = page.getByLabel("Private share link", { exact: true });
      await expect(linkField).toBeVisible({ timeout: 60_000 });
      await recipient.goto(await linkField.inputValue());
      const prompt = recipient.getByRole("dialog", {
        name: "Download this share?",
      });
      await expect(prompt).toBeVisible({ timeout: 60_000 });
      if (count === 2)
        await prompt.getByLabel("Save files as").selectOption("separate");
      else await expect(prompt.getByLabel("Save files as")).toBeHidden();
      const received: Promise<{ name: string; contents: string }>[] = [];
      const onDownload = (download: import("@playwright/test").Download) => {
        received.push(
          download.path().then(async (path) => ({
            name: download.suggestedFilename(),
            contents: await readFile(path!, "utf8"),
          })),
        );
      };
      recipient.on("download", onDownload);
      await prompt
        .getByRole("button", {
          name: count === 2 ? "Download all files" : "Download file",
          exact: true,
        })
        .click();
      await expect(
        recipient.getByText(
          count === 2 ? "Files verified." : "File verified.",
          { exact: false },
        ),
      ).toBeVisible();
      await expect.poll(() => received.length).toBe(count);
      expect(await Promise.all(received)).toEqual(
        fixture.slice(0, count).map((file) => ({
          name: file.name,
          contents: file.buffer.toString(),
        })),
      );
      recipient.off("download", onDownload);
      await recipient
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await page.getByRole("button", { name: "Stop sharing" }).click();
    }
  } finally {
    await context.close();
  }
});

test("expiry choices and connection limit validation", async ({
  page,
}, info) => {
  await page.goto("/");
  await page
    .getByLabel("Choose files to share", { exact: true })
    .setInputFiles({
      name: "test.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("test"),
    });
  const expiry = page.getByLabel("Link & key expiry");
  await expect(expiry).toHaveValue("60");
  await expiry.selectOption("never");
  await expect(
    page.getByText(
      "No time limit. Closing this tab or stopping sharing revokes the link and key.",
    ),
  ).toBeVisible();
  await expiry.selectOption("uses");
  const limit = page.getByLabel("Recipient connections", { exact: true });
  await expect(limit).toHaveValue("1");
  await limit.fill("0");
  await expect(
    page.getByRole("button", { name: "Create share link", exact: true }),
  ).toBeDisabled();
  await limit.fill("1.5");
  await expect(limit).toHaveAttribute("aria-invalid", "true");
  await limit.fill("3");
  await expect(
    page.getByRole("button", { name: "Create share link", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (
    info.project.name === "chromium" ||
    info.project.name === "mobile-safari"
  ) {
    await mkdir(".impeccable/review", { recursive: true });
    await page.screenshot({
      path: `.impeccable/review/expiry-${info.project.name}.png`,
      fullPage: true,
    });
  }
});

test("real Tailcat WASM: usage limit blocks new recipients and preserves the last visit", async ({
  browser,
  page,
}, info) => {
  test.skip(
    process.env.TAILSHARE_NETWORK !== "1",
    "Requires public DERP relays.",
  );
  await page.goto("/");
  await page
    .getByLabel("Choose files to share", { exact: true })
    .setInputFiles({
      name: "visit.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("One recipient, multiple downloads."),
    });
  await page.getByLabel("Link & key expiry").selectOption("uses");
  await page.getByLabel("Recipient connections", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Create share link", exact: true })
    .click();
  const linkField = page.getByLabel("Private share link", { exact: true });
  await expect(linkField).toBeVisible({ timeout: 60_000 });
  const link = await linkField.inputValue();
  const context = await browser.newContext({
    ...info.project.use,
    acceptDownloads: true,
  });
  await context.addInitScript(() =>
    Object.defineProperty(window, "showSaveFilePicker", {
      value: undefined,
      configurable: true,
    }),
  );
  const recipient = await context.newPage();
  const rejected = await context.newPage();
  try {
    await recipient.goto(link);
    const prompt = recipient.getByRole("dialog", {
      name: "Download this share?",
    });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole("button", { name: "Link expired", exact: true }),
    ).toBeDisabled();
    await expect(linkField).toBeHidden();
    await expect(page.getByText("1 / 1", { exact: true })).toBeVisible();
    // Verify both invitation forms share the same host-enforced limit.
    await rejected.goto("/");
    await rejected
      .getByRole("button", { name: "Receive files", exact: true })
      .click();
    await rejected
      .getByLabel("Share link or key")
      .fill(new URL(link).hash.slice(1));
    await rejected.getByRole("button", { name: "Connect to sender" }).click();
    await expect(rejected.getByRole("alert")).toBeVisible({ timeout: 30_000 });
    await expect(rejected.getByRole("dialog")).toBeHidden();
    const first = recipient.waitForEvent("download");
    await prompt
      .getByRole("button", { name: "Download file", exact: true })
      .click();
    expect(await readFile((await (await first).path())!, "utf8")).toBe(
      "One recipient, multiple downloads.",
    );
    const again = recipient.waitForEvent("download");
    await recipient.getByLabel("Download visit.txt", { exact: true }).click();
    expect(await readFile((await (await again).path())!, "utf8")).toBe(
      "One recipient, multiple downloads.",
    );
    await recipient
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(
      page.getByText(
        "All uses were consumed and the last recipient disconnected. Create a new link to share again.",
      ),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await context.close();
    const stop = page.getByRole("button", { name: "Stop sharing" });
    if (await stop.isVisible()) await stop.click();
  }
});
