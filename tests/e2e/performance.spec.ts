import { test, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";

// Deliberately opt-in: these synthetic measurements consume public relay bandwidth.
test("transfer performance measurement", async ({ browser, page }, info) => {
  test.skip(process.env.TAILSHARE_BENCHMARK !== "1", "Opt-in benchmark only.");
  test.setTimeout(600_000);
  page.setDefaultTimeout(30_000);
  const large = Buffer.alloc(4 * 1024 * 1024, 43);
  const small = Buffer.alloc(16 * 1024, 17);
  const files = [
    { name: "large.bin", mimeType: "application/octet-stream", buffer: large },
    ...Array.from({ length: 16 }, (_, i) => ({
      name: `small-${i}.bin`,
      mimeType: "application/octet-stream",
      buffer: small,
    })),
  ];
  const results: object[] = [];
  const processes: ReturnType<typeof spawn>[] = [];
  async function cli(kind: "serve" | "recv") {
    const root = info.outputPath(kind);
    await mkdir(root, { recursive: true });
    if (kind === "serve")
      for (const file of files)
        await writeFile(join(root, file.name), file.buffer);
    const proc = spawn(
      resolve("transport/.build/tailcat"),
      kind === "serve"
        ? ["serve", "--key=new", `--files=${root}:ro`, "files"]
        : ["recv", "--key=new", root],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: info.outputPath("config-" + kind),
        },
      },
    );
    processes.push(proc);
    const key = await new Promise<string>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("Benchmark CLI startup timed out")),
        45_000,
      );
      let text = "";
      const scan = (data: Buffer) => {
        text = (text + data.toString()).slice(-8192);
        const match = text.match(/\btc[A-Za-z0-9_-]{20,2048}\b/);
        if (match) {
          clearTimeout(timer);
          done(match[0]);
        }
      };
      proc.stdout!.on("data", scan);
      proc.stderr!.on("data", scan);
      proc.once("error", () => {
        clearTimeout(timer);
        fail(new Error("Build the benchmark CLI first"));
      });
    });
    return { root, key };
  }
  async function instrument(p: Page) {
    await p.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        value: undefined,
        configurable: true,
      });
      const state = { longTasks: 0, blockedMs: 0, maxFrameMs: 0 };
      (window as unknown as { bench: typeof state }).bench = state;
      if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.longTasks++;
            state.blockedMs += entry.duration;
          }
        }).observe({ type: "longtask" });
      let last = performance.now();
      function frame(now: number) {
        state.maxFrameMs = Math.max(state.maxFrameMs, now - last);
        last = now;
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }
  async function measure(
    p: Page,
    name: string,
    size: number,
    action: () => Promise<void>,
  ) {
    await p.evaluate(() => {
      const s = (window as unknown as { bench: Record<string, number> }).bench;
      s.longTasks = s.blockedMs = s.maxFrameMs = 0;
    });
    const start = performance.now();
    await action();
    const seconds = (performance.now() - start) / 1000;
    const ui = await p.evaluate(
      () => (window as unknown as { bench: Record<string, number> }).bench,
    );
    console.log(`Measured ${name}: ${seconds.toFixed(3)} seconds`);
    results.push({
      name,
      bytes: size,
      seconds: +seconds.toFixed(3),
      mibPerSecond: +(size / 1048576 / seconds).toFixed(3),
      ...ui,
    });
  }
  async function receive(p: Page, name: string) {
    await measure(p, name + " large", large.length, async () => {
      const pending = p.waitForEvent("download");
      await p.getByLabel("Download large.bin", { exact: true }).click();
      expect(await readFile((await (await pending).path())!)).toEqual(large);
    });
    await measure(p, name + " many", small.length * 16, async () => {
      for (let i = 0; i < 16; i++)
        await p.getByLabel(`Select small-${i}.bin`, { exact: true }).check();
      const pending = p.waitForEvent("download");
      await p
        .getByRole("button", { name: "ZIP selected files", exact: true })
        .click();
      const entries = unzipSync(
        await readFile((await (await pending).path())!),
      );
      expect(Object.keys(entries)).toHaveLength(16);
      for (const bytes of Object.values(entries))
        expect(Buffer.from(bytes)).toEqual(small);
    });
  }
  const context = await browser.newContext({
    ...info.project.use,
    acceptDownloads: true,
  });
  const recipient = await context.newPage();
  try {
    await instrument(page);
    await instrument(recipient);
    await page.goto("/");
    await page
      .getByLabel("Choose files to share", { exact: true })
      .setInputFiles(files);
    await measure(page, "browser sender startup", 0, async () => {
      await page
        .getByRole("button", { name: "Create share link", exact: true })
        .click();
      await expect(
        page.getByLabel("Private share link", { exact: true }),
      ).toBeVisible({ timeout: 65_000 });
    });
    await recipient.goto(
      await page.getByLabel("Private share link", { exact: true }).inputValue(),
    );
    await recipient
      .getByRole("button", { name: "Browse first", exact: true })
      .click({ timeout: 65_000 });
    await receive(recipient, "browser to browser");
    await page
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    await recipient.close();
    const served = await cli("serve");
    await page.goto("/");
    await page
      .getByRole("button", { name: "Receive files", exact: true })
      .click();
    await page.getByLabel("Share link or key").fill(served.key);
    await page.getByRole("button", { name: "Connect to sender" }).click();
    await expect(
      page.getByText("Connected to CLI share.", { exact: false }),
    ).toBeVisible({ timeout: 65_000 });
    await receive(page, "CLI to browser");
    const inbox = await cli("recv");
    await page.goto("/");
    await page
      .getByRole("combobox", { name: "Send to", exact: true })
      .selectOption("cli");
    for (const [name, batch] of [
      ["large", files.slice(0, 1)],
      ["many", files.slice(1)],
    ] as const) {
      await page
        .getByLabel("Choose files to share", { exact: true })
        .setInputFiles(batch);
      await page.getByLabel("CLI receiver key").fill(inbox.key);
      await measure(
        page,
        "browser to CLI " + name,
        batch.reduce((n, f) => n + f.buffer.length, 0),
        async () => {
          await page
            .getByRole("button", { name: "Send to CLI", exact: true })
            .click();
          await expect(
            page.getByText(
              `${batch.length} ${batch.length === 1 ? "file sent" : "files sent"}.`,
              { exact: false },
            ),
          ).toBeVisible({ timeout: 180_000 });
        },
      );
      const names = await readdir(inbox.root);
      for (const f of batch)
        expect(
          await readFile(
            join(
              inbox.root,
              names.find((n) => n.startsWith(f.name.slice(0, -4) + "."))!,
            ),
          ),
        ).toEqual(f.buffer);
    }
    await writeFile(
      info.outputPath("measurements.json"),
      JSON.stringify(results, null, 2),
    );
    console.log(
      JSON.stringify({ profile: info.project.name, measurements: results }),
    );
  } finally {
    await context.close();
    await Promise.all(
      processes.map(
        (proc) =>
          new Promise<void>((done) => {
            if (proc.exitCode !== null) return done();
            proc.once("exit", () => {
              clearTimeout(timer);
              done();
            });
            const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
            proc.kill("SIGTERM");
          }),
      ),
    );
  }
});
