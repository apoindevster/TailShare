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
  const shortcut = await page.evaluate(async () => {
    const manifestURL = document.querySelector<HTMLLinkElement>(
      'link[rel="manifest"]',
    )!.href;
    const manifest = await (await fetch(manifestURL)).json();
    const appleIcon = document.querySelector<HTMLLinkElement>(
      'link[rel="apple-touch-icon"]',
    )!.href;
    const urls = [
      appleIcon,
      ...manifest.icons.map(
        (icon: { src: string }) => new URL(icon.src, manifestURL).href,
      ),
    ];
    const dimensions = await Promise.all(
      urls.map(
        (url) =>
          new Promise<number[]>((resolve, reject) => {
            const image = new Image();
            image.onload = () =>
              resolve([image.naturalWidth, image.naturalHeight]);
            image.onerror = () =>
              reject(new Error(`Home-screen icon failed to load: ${url}`));
            image.src = url;
          }),
      ),
    );
    return {
      startURL: new URL(manifest.start_url, manifestURL).href,
      display: manifest.display,
      dimensions,
    };
  });
  expect(shortcut).toEqual({
    startURL: origin + prefix,
    display: "browser",
    dimensions: [
      [180, 180],
      [192, 192],
      [512, 512],
      [512, 512],
    ],
  });
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
