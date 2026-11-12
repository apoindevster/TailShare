import { test, expect } from "@playwright/test";

test("static project subpath loads the UI and real WASM without a backend", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const prefix = "/tailshare-project/";
  const localRequests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) localRequests.push(url.pathname);
  });
  // Serve the exact production bytes at a GitHub-style project path. Root
  // requests are NOT rewritten, so the assertion detects escaped asset URLs.
  await page.route(`${origin}${prefix}**`, async (route) => {
    const url = new URL(route.request().url());
    url.pathname = "/" + url.pathname.slice(prefix.length);
    const response = await route.fetch({ url: url.href });
    await route.fulfill({ response });
  });
  // Only initialize the actual WASM here; network transfer tests opt into relays.
  await page.route("https://tailcat.dev/**", (route) => route.abort());
  await page.goto(origin + prefix);
  await expect(
    page.getByRole("heading", { name: "Your files. Their browser." }),
  ).toBeVisible();
  await page
    .getByLabel("Choose files to share", { exact: true })
    .setInputFiles({
      name: "deployment-check.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Static deployment smoke check"),
    });
  await page
    .getByRole("button", { name: "Create share link", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => typeof window.tailshareListen))
    .toBe("function");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(localRequests.every((path) => path.startsWith(prefix))).toBe(true);
  expect(
    localRequests.some((path) =>
      /transport\/tailcat-[a-f0-9]{16}\.wasm\.gz$/.test(path),
    ),
  ).toBe(true);
  expect(
    localRequests.some((path) =>
      /transport\/wasm_exec-[a-f0-9]{16}\.js$/.test(path),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
