import { test, expect } from "@playwright/test";
import { gunzipSync } from "node:zlib";

test("engine readiness keeps the create action stable at the page bottom", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/transport/wasm_exec-*.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await page
      .getByLabel("Choose files to share", { exact: true })
      .setInputFiles({
        name: "stable-action.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic fixture"),
      });
    await expect(
      page.getByText("Downloading transfer engine", { exact: false }),
    ).toBeVisible();
    // At the scroll limit, removing even a short status line can move a button
    // between pointer-down and pointer-up, losing an otherwise valid click.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const action = page.getByRole("button", {
      name: "Create share link",
      exact: true,
    });
    const before = await action.boundingBox();
    release();
    await expect(
      page.getByText("Transfer engine ready.", { exact: true }),
    ).toBeVisible();
    const after = await action.boundingBox();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  } finally {
    release();
  }
});

test("engine loading recovers and accepts host-decompressed WASM", async ({
  page,
}, info) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let first = true;
  await page.route("**/transport/wasm_exec-*.js", async (route) => {
    if (first) {
      first = false;
      await gate;
      await route.fulfill({ status: 503, body: "Synthetic unavailable asset" });
    } else await route.continue();
  });
  await page.route("**/transport/tailcat-*.wasm.gz", async (route) => {
    const response = await route.fetch();
    const bytes = await response.body();
    await route.fulfill({
      status: 200,
      contentType: "application/wasm",
      body: bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes,
    });
  });
  try {
    await page.goto("/");
    await page
      .getByLabel("Choose files to share", { exact: true })
      .setInputFiles({
        name: "loading.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic loading test"),
      });
    await expect(
      page.getByText("Downloading transfer engine", { exact: false }),
    ).toBeVisible();
    if (
      info.project.name === "chromium" ||
      info.project.name === "mobile-safari"
    ) {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: `.impeccable/review/optimized-loading-${info.project.name}.png`,
        fullPage: true,
      });
    }
    release();
    await expect(
      page.getByRole("button", { name: "Retry transfer engine" }),
    ).toBeVisible();
    if (
      info.project.name === "chromium" ||
      info.project.name === "mobile-safari"
    )
      await page.screenshot({
        path: `.impeccable/review/optimized-error-${info.project.name}.png`,
        fullPage: true,
      });
    await page.getByRole("button", { name: "Retry transfer engine" }).click();
    await expect
      .poll(() => page.evaluate(() => typeof window.tailshareListen))
      .toBe("function");
    await expect(
      page.getByRole("button", { name: "Retry transfer engine" }),
    ).toBeHidden();
  } finally {
    release();
  }
});

test("selection warms one worker and versioned assets without opening a relay", async ({
  page,
}, info) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.route("https://tailcat.dev/**", (route) => route.abort());
  await page.goto("/");
  const workerReady = page.waitForEvent("worker");
  const fixture = {
    name: "worker-test.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic worker test"),
  };
  await page
    .getByLabel("Choose files to share", { exact: true })
    .setInputFiles(fixture);
  const worker = await workerReady;
  await expect
    .poll(() => page.evaluate(() => typeof window.tailshareListen))
    .toBe("function");
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { Go?: unknown }).Go,
    ),
  ).toBe("undefined");
  expect(
    await worker.evaluate(
      () => typeof (globalThis as unknown as { Go?: unknown }).Go,
    ),
  ).toBe("function");
  await page
    .getByLabel("Choose files to share", { exact: true })
    .setInputFiles(fixture);
  expect(page.workers()).toHaveLength(1);
  expect(
    requests.filter((url) => url.startsWith("https://tailcat.dev")),
  ).toEqual([]);
  const wasm = requests.find((url) =>
    /tailcat-[a-f0-9]{16}\.wasm\.gz$/.test(url),
  )!;
  const version = wasm.match(/tailcat-([a-f0-9]{16})/)![1];
  expect(requests.some((url) => url.endsWith(`wasm_exec-${version}.js`))).toBe(
    true,
  );
  // Worker failures expose an explicit retry; a replacement worker uses the same pair.
  await worker.evaluate(() => {
    setTimeout(() => postMessage({ event: "fatal" }), 25);
  });
  await expect(
    page.getByRole("button", { name: "Retry transfer engine" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry transfer engine" }).click();
  await expect(
    page.getByRole("button", { name: "Retry transfer engine" }),
  ).toBeHidden();
  await expect.poll(() => page.workers().length).toBe(1);
  if (
    info.project.name === "chromium" ||
    info.project.name === "mobile-safari"
  ) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `.impeccable/review/optimized-ready-${info.project.name}.png`,
      fullPage: true,
    });
  }
});

test("keep-awake preference handles waiting and an unsupported browser", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      },
    });
  });
  await page.goto("/");
  await page.getByLabel("Keep screen awake", { exact: true }).check();
  await expect(
    page.getByText("Will request when sharing or transferring starts."),
  ).toBeVisible();
  await page.getByLabel("Keep screen awake", { exact: true }).uncheck();
  await expect(
    page.getByText("Optional while sharing or transferring.", { exact: false }),
  ).toBeVisible();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: undefined,
    });
  });
  await page.reload();
  await expect(
    page.getByLabel("Keep screen awake", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("This browser cannot keep the screen awake.", {
      exact: false,
    }),
  ).toBeVisible();
});

test("keep-awake releases on cancellation without reporting a successful upload", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    const state = { requests: 0, releases: 0, writeStarted: false };
    (window as unknown as { wakeTest: typeof state }).wakeTest = state;
    Object.defineProperty(navigator, "wakeLock", {
      value: {
        request: async () => {
          state.requests++;
          return {
            release: async () => {
              state.releases++;
            },
            addEventListener: () => {},
          };
        },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Send to", exact: true })
    .selectOption("cli");
  await page
    .getByLabel("Choose files to share", { exact: true })
    .setInputFiles({
      name: "awake.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic wake test"),
    });
  await expect
    .poll(() => page.evaluate(() => typeof window.tailshareCLIConnect))
    .toBe("function");
  // Exercise the UI lifecycle without requiring a public relay or an OS permission dialog.
  await page.evaluate(() => {
    window.tailshareCLIStart = async () => 1;
    window.tailshareCLIConnect = async () => "";
    window.tailshareCLIClose = () => {};
    window.tailshareCLIUpload = async (_id, op) => {
      if (op === "write") {
        (
          window as unknown as { wakeTest: { writeStarted: boolean } }
        ).wakeTest.writeStarted = true;
        await new Promise(() => {});
      }
    };
  });
  await page.getByLabel("Keep screen awake", { exact: true }).check();
  await page.getByLabel("CLI receiver key").fill("tc" + "a".repeat(100));
  await page.getByRole("button", { name: "Send to CLI", exact: true }).click();
  await expect(
    page.getByText("Screen wake lock active.", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { wakeTest: { writeStarted: boolean } })
            .wakeTest.writeStarted,
      ),
    )
    .toBe(true);
  if (
    info.project.name === "chromium" ||
    info.project.name === "mobile-safari"
  ) {
    await page.screenshot({
      path: `.impeccable/review/optimized-active-${info.project.name}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { wakeTest: { releases: number } }).wakeTest
            .releases,
      ),
    )
    .toBe(1);
  await expect(
    page.getByText("Transfer stopped.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Will request when sharing or transferring starts."),
  ).toBeVisible();
});
