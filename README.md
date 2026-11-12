# TailShare

A static file browser and sharing application for browser-to-browser and browser/CLI transfers, built with React, TypeScript, and [Tailcat](https://github.com/tailscale/tailcat) compiled to Go WebAssembly. Inspired by [Tailcatchat](https://github.com/tailscale/tailcatchat). No TailShare backend, account, database, or hosted file storage.

Browser Tailcat currently carries encrypted traffic through public DERP relays. “No backend” does **not** mean no network infrastructure: the static host serves the app and WASM, `tailcat.dev` supplies the relay map, and DERP carries end-to-end encrypted streams. Both endpoints must remain online and awake: two browsers, or a browser and a sender running `tailcat serve files` or recipient running `tailcat recv`.

## Run locally

Use Node 22.12+ (Node 24 recommended), npm 10+, and Go 1.27.4+. A Go installation supporting automatic toolchain downloads will obtain the version declared in `transport/go.mod`.

```sh
npm ci
npm run build:wasm
npm run dev
```

Open the URL printed by Vite. The first WASM build downloads the pinned Go dependencies. The browser prepares approximately 6.3 MiB of compressed WASM after file selection or when joining a share. Preparing the engine loads static assets only; it does not contact a peer or publish a share.

```sh
npm run build      # WASM + type checking + static production build
npm run preview    # serve dist locally with the production CSP
```

Deploy only `dist/` to any HTTPS static host. A local development/preview HTTP server is build tooling, not an application backend. Relative asset URLs support deployment under a subdirectory. No runtime environment secrets are required. After bridge changes, rebuild WASM, restart `npm run dev` so Vite picks up the new asset version, and reload the page.

## Use

1. Pick one or more files, choose a directory, or drop files/folders. Inspect or remove items before sharing.
2. Choose the link and key expiry: 15 minutes, 1 hour, 4 hours, Never (while this tab is open), or after 1–1,000 recipient connections. Then create the link.
3. Send the link or complete share key through a separate trusted channel. Treat it as a password.
4. Opening or pasting a full link shows every shared file and its size in a download confirmation. Confirming immediately starts the entire download: one original file, or a ZIP by default for multiple files, with a separate-file option. Browser save/destination prompts may still appear. “Browse first” or Escape dismisses the prompt without downloading. Pasting only the share key connects directly to the file browser without a download prompt or automatic download. While browsing, choose individual files, a separate-file batch, or a ZIP. Checkbox selection limits batch downloads; with no selection, a batch includes the full share.
5. Keep both browsers in the foreground, especially on phones. Stop sharing to revoke access. Already-downloaded files remain on recipients' devices.

Every browser-hosted session uses fresh Tailcat keys and an additional random 256-bit application capability. Links contain `#share=tc…&key=…`. A browser-hosted share requires its complete share key; a bare Tailcat address connects only to a CLI file service. The recipient removes link credentials from the address bar immediately. Refreshing ends that recipient's session; paste the link or key again to reconnect.

## Receive from `tailcat serve`

The recipient needs only TailShare in a supported browser. The sender installs the [Tailcat CLI](https://github.com/tailscale/tailcat/blob/main/INSTALL.md), places the files to offer in a dedicated directory, and runs:

```sh
tailcat serve --key=new --files=./shared:ro files
```

Replace `./shared` with the directory to share. `:ro` makes the server read-only. To offer a single file, put just that file in the shared directory. To offer the current directory, `tailcat serve --key=new --files=.:ro` also works: `--files` enables the file service without a trailing `files` argument. Your command can omit `:ro`, but that permits writes by other CLI clients holding the key. Every readable regular file in the served tree, including hidden files, can be offered; use a directory containing only what you intend to share.

1. Send the complete `tc…` key printed by the command through a trusted channel. It contains a WireGuard preshared secret, so treat it like a password.
2. The recipient opens TailShare, chooses **Receive files**, pastes that key into **Share link or key**, and selects **Connect to sender**. There is no second token, account, extension, or CLI installation on the receiving device.
3. The file browser opens without automatically downloading or showing a download confirmation. Browse folders, select files, download an individual file, save a separate-file batch, or download a ZIP using the existing controls.
4. Keep the sender's command running and the receiving browser in the foreground. Stop the command with Ctrl+C to stop access. `--key=new` creates a fresh address on the next run; deliberately reusing a saved CLI key can restore access for previous key holders.

This connects to the CLI's **SFTP file service on Tailcat port 22**, entirely inside the browser's WASM runtime. Plain `tailcat serve` with no `files` service is a byte pipe and cannot provide a directory listing. The Receive files flow never uploads, deletes, or edits remote files, even if the CLI serves a writable directory. To send into a `tailcat recv` inbox, use the Send files flow below. SSH services requiring login keys/passwords, custom relays, and `--full-address` addresses are not supported. Use the default public relay map and keep the default `--psk=true`; addresses without that protection are rejected.

CLI compatibility is tested against the same pinned Tailcat revision as the WASM transport: `e00cdde6ff787f801361ff85ed085775c775d4c5`. See upstream's [file-service usage](https://github.com/tailscale/tailcat/tree/e00cdde6ff787f801361ff85ed085775c775d4c5#send-and-receive-files).

CLI browsing loads only the current folder, in pages of at most 128 entries. **There is no 10,000-entry limit on a CLI directory or the entire served tree.** The root appears without scanning its subdirectories; open a folder to request its contents. **Next page** requests another batch, **Previous page** revisits earlier batches, and **Refresh folder** restarts the current listing. Four pages are cached; older pages are reread from the beginning when needed. Names are sorted within each page, not across the whole directory. Keep the directory stable while paging; this is a live listing, not an immutable snapshot.

**Filter this page** and **Select visible items** apply only to the current page. Changing pages or folders clears the selection. Selecting a folder includes its unopened descendants when downloading. With nothing selected, downloads cover the current folder and its subfolders; at the root, **Download all as ZIP** covers the whole share. File counts and sizes describe the listed page, not the entire tree. Recursive downloads discover and stream entries as they proceed, so the final count and size are not known in advance.

Packets, pages, open directory handles, cached metadata, and per-request time are bounded instead of limiting the total tree. Paths still have the portable-name and 32-segment restrictions. Symbolic links and special files are skipped, and unsafe names are rejected. ZIP downloads retain the 4 GB bound and also enforce ZIP32's 65,535-entry maximum and an 8 MiB archive-metadata budget. These archive limits do not limit browsing or separate downloads to disk. Memory-only browsers retain the 256 MB limit; a folder ZIP exceeding it is discarded, while a separate-file batch can leave earlier downloads saved. Use smaller folders or desktop Chrome/Edge's disk-saving support for larger transfers.

Keep files unchanged during transfer: size, modification time, and complete delivery are checked before each file is committed. SFTP/SSH and WireGuard authenticate the transport; the CLI does **not** supply TailShare's separate sender SHA-256 checksum, and metadata checks cannot detect every concurrent edit. CLI downloads therefore say “downloaded,” not “verified.” A failed or cancelled ZIP is aborted; separate downloads and newly created directories may remain after interruption. There is no automatic retry or resume.

If a folder fails to load, check its permissions or refresh its parent if it was moved. A listing request has a 60-second deadline and a separate 65-second page fallback if the worker never answers (browser suspension can delay timers). Cancel disconnects the session and interrupts pending reads. Project/home shares include hidden files, `.git`, dependencies, and configuration: TailShare does not apply `.gitignore`. Use a deliberately chosen shared directory.

TailShare's time and use-count dropdown controls browser-hosted shares only. A CLI share has the lifetime and access rules of its running CLI process, not a TailShare expiry timer or recipient-use counter.

## Send from the browser to `tailcat recv`

The recipient creates an inbox directory, starts the CLI, and privately sends its printed `tc…` key to the browser sender:

```sh
mkdir -p ./inbox
tailcat recv --key=new ./inbox
```

In TailShare, choose **Send files**, set **Send to** to **Tailcat CLI · receiver key**, and pick files or a folder. Inspect or remove items in the file browser, paste the key into **CLI receiver key**, choose a format, and click **Send to CLI**. Pasting a key alone sends nothing. The browser clears the key on starting and does not create a share link for this transfer. Keep the browser in the foreground and the CLI running until completion.

| Format | CLI command | Result |
| --- | --- | --- |
| Separate files | `tailcat recv --key=new ./inbox` | All selected files are sent individually into the inbox. Folder paths and empty folders are omitted. The default CLI gives each file a unique timestamp/random name while retaining its extension. |
| ZIP archive | `tailcat recv --key=new ./inbox` | One streaming, uncompressed ZIP preserves original file names, paths, and available empty folders. The inbox assigns the archive a unique name. ZIP output is limited to below 4 GB including overhead. |
| Folder tree | `tailcat recv --key=new --accept-dirs ./inbox` | Selected files and available empty folders go into a fresh `TailShare-…` directory. Relative paths are preserved. |

The default flat inbox prevents senders from listing/reading existing files or probing for name collisions. `--accept-dirs` also permits directory creation and stat calls, exposing some information about existing directory paths to key holders. TailShare never lists or reads the receiver's inbox. It creates a new random parent folder for tree uploads and requests exclusive creation for files; it never truncates, deletes, renames, or overwrites existing remote files. If the recipient omits `--accept-dirs`, folder-tree mode fails with guidance to use that flag or choose ZIP. See the pinned CLI's [receive-command help](https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/cmd/tailcat/tailcat.go).

Uploads use bounded 256 KiB batches, pipelining at most eight 32 KiB SFTP requests; the receiving-browser 256 MiB memory limit does not apply to sending. Separate files and folder trees are not limited to the ZIP maximum, but browser access to the source, available receiver disk space, and connection continuity still matter. The selection has the usual 10,000-entry and path limits. Directory-input fallbacks may omit empty folders. Long file names may need shortening because the flat CLI adds a suffix.

Success means the CLI acknowledged writes and close and reported the resulting size over authenticated SSH/WireGuard. Its write-only inbox cannot supply a read-back checksum; TailShare does not claim independent SHA-256 verification or durable disk flush. Downloads/uploads are not atomic across a batch. **Cancel, disconnect, a full disk, or a closed tab can leave completed files, partial files, or folders in the inbox.** TailShare cannot remove or roll these back through a write-only inbox. The recipient should inspect and clean them up before a retry, which starts a new transfer and can create duplicates. There is no automatic retry or resume.

Treat the receiver key as permission to deposit files: anyone holding it may use the CLI until it stops, and may consume inbox disk space. Use a dedicated inbox and stop the command when finished. Browser-share expiry/use limits do not apply to this direction either. The same default relay, preshared-key, and CLI-version requirements described above apply. All application hosting remains static on GitHub Pages or Cloudflare Pages.

## Expiry and uses

The link and key grant access to the same session and expire together. Time limits close new and existing connections at the deadline and interrupt in-progress transfers. Files already received or saved cannot be revoked. Never removes the time limit, but Stop sharing, closing or refreshing the sender's tab, or loss of that browser session still ends the share.

A use means one **successfully authenticated recipient connection**. Opening a link consumes a use even if the recipient dismisses the download confirmation. The recipient may browse and download multiple files or ZIPs during that visit without consuming more uses. Reconnecting or opening another recipient tab consumes another use. Bad authentication does not consume a use. This counts connections, not distinct people; there is no identity tracking.

After the final use, new connections are refused and copy controls disappear. Already admitted recipients can finish while the sender keeps the tab open. The share closes when the last recipient disconnects; Stop sharing revokes it immediately. Resource and idle timeouts still apply. The sender shows the connection count and whether the invitation is exhausted.

## Browser behavior and limits

| Capability | Desktop Chrome / Edge | Firefox / Safari / mobile |
| --- | --- | --- |
| Pick multiple files | Yes | Yes |
| Directory browsing | Native directory picker or directory input | Directory input where the OS/browser exposes it |
| Large individual download | Stream to a user-chosen disk file | Memory-backed download, maximum 256 MiB |
| Separate-file batch | Choose a destination once; save into a fresh `TailShare-<uuid>` subfolder | Browser downloads; 256 MiB maximum total per batch; multiple-download approval may be required |
| ZIP | Stream to disk, below 4,000,000,000 bytes including overhead | Below 256 MiB including overhead |

Limits are applied before downloading where possible and while receiving. Available device memory can be lower than the configured maximum. ZIP is a streaming **stored archive** (no compression), preserving paths and empty folders when available. ZIP64 and compression are not implemented. Directory-input fallbacks omit empty folders. File names that are unsafe on another platform are rejected with a rename instruction. Browser-origin selections allow 10,000 total file/folder entries and 32 path segments; that selection limit also applies when sending from the browser to a CLI. CLI receiving uses paged listings without a total-entry limit.

Native save pickers are progressive enhancement. The fallback produces a download after verification; the browser controls where and whether it is saved. Files are never previewed, executed, or extracted by TailShare. A SHA-256 match verifies transmission, not that a sender's file is trustworthy.

Interrupted downloads restart from the beginning. Phone screen lock, background throttling, or tab suspension can interrupt transfers. This version does not implement resumable transfers, service workers, persistent shares, or peer identity verification.

## Transfer performance and screen sleep

The Go/WASM network stack, encryption, and SFTP client run in a dedicated Web Worker. Browser file selection, streaming SHA-256/ZIP processing, and save prompts remain in the page. This keeps the existing protocol and file permissions while moving the transport off the interface thread. Worker messages and CLI batches are bounded; transfers still respect sink backpressure. Browser transfers combine each data frame's header and payload into one write, avoiding an extra worker round trip without changing the wire format. Progress rendering updates roughly ten times per second, with immediate file changes, completion, and cancellation.

CLI transfers process one file at a time with at most eight 32 KiB requests in flight within a 256 KiB batch. ZIP uploads coalesce small output fragments into these batches. Every batch and the final close/size check must succeed before completion is reported. A failed parallel batch can leave noncontiguous partial data in the receiver's inbox; it is not safe to append or resume blindly.

**Keep screen awake** is optional and off by default. When enabled, TailShare requests a screen wake lock while a browser share is open or a transfer is running, releases it on stop/completion, and requests it again after returning to a visible page. Browser denial, low battery, or a system release is shown in the interface. Turning the option off releases it immediately. It does not provide background execution or guarantee transfers through screen lock, app switching, or tab closure. An idle receiving browser does not hold a wake lock. The preference is not persisted.

The transfer engine shows loading/retry status and can be prepared while you inspect a selection. Its runtime and WASM share versioned URLs to avoid mixing builds. If a deployment removes assets an old open tab has not loaded yet, reload that tab to get the new build. Versioning does not provide offline availability or retain old deployments. Cloudflare uses long-lived caching for these versioned files; GitHub Pages controls its own cache headers.

An optional repeatable benchmark uses only synthetic files: a 4 MiB file and sixteen 16 KiB files in all three directions. Run `npm run build:test-cli`, `npm run build`, then `TAILSHARE_BENCHMARK=1 npm run test:e2e -- tests/e2e/performance.spec.ts --project=chromium`. It records timings and main-thread long tasks in ignored test results, verifies every output, and prints no keys. It consumes public relay bandwidth and is excluded from ordinary CI. Results depend on relay latency/load and the device; see TESTING.md for the measured scope.

## Tests

```sh
npm test                    # local security/protocol/ZIP tests; no relay access
npm run test:go              # native SSH/SFTP adapter and safety tests; loopback only
npm run check               # strict TypeScript check
npx playwright install chromium firefox webkit
npm run build
npm run test:e2e             # UI and responsive tests in five browser profiles
npm run build:test-cli       # build the pinned CLI into ignored transport/.build/
TAILSHARE_NETWORK=1 npm run test:e2e  # actual browser/browser and CLI/browser transfers
npm audit
```

Browser profiles are desktop Chromium, Firefox, WebKit, and mobile Chrome/Safari emulations. Emulation is not physical-phone certification. Network tests require access to `tailcat.dev` and its `tc301a`–`tc304a.ipn.dev` HTTPS/WSS endpoints. They test nested directory browsing, individual downloads, ZIP contents, binary/empty files, fragment removal, credential non-disclosure in HTTP requests, and revocation. Test artifacts can contain **ephemeral synthetic-test** invitations; do not run these tests with personal files.

Go dependency scanning (build the scanner with a toolchain at least as new as the project):

```sh
GOTOOLCHAIN=go1.27.4 go install golang.org/x/vuln/cmd/govulncheck@v1.9.0
cd transport
GOOS=js GOARCH=wasm govulncheck -tags="$(cat build-tags.txt),ts_omit_exec,ts_omit_ssh,ts_omit_sftp" ./...
```

## Architecture

- `src/lib/model.ts`: virtual file tree, manifest validation, safe paths, fragment capabilities.
- `src/lib/picker.ts`: local picker and recursive drop enumeration. Only selected `File` objects are retained.
- `src/lib/transport.ts`: lazy WASM loading and the typed Tailcat bridge.
- `transport/main_js.go`: ephemeral Tailcat server/client, only TCP port 1443; bounded reads/writes and resource cleanup.
- `src/lib/wire.ts`: length-prefixed JSON/data frames. 64 KiB data chunks, 4 MiB manifest cap, 4 KiB request cap.
- `src/lib/session.ts`: authenticated manifest exchange, file requests by opaque ID, sequential transfer, incremental SHA-256 verification, expiry and revocation.
- `src/lib/cli.ts`, `src/lib/cli-download.ts`, `transport/cli.go`, `transport/cli_directory.go`, `transport/cli_js.go`: CLI transport and read-only receiver, paged SFTP listing/reads over Tailcat, cancellation, and file-change checks.
- `src/lib/cli-send.ts`, `transport/cli_upload.go`: explicit browser-to-CLI uploads, validated selection IDs, exclusive writes, streaming ZIP, and fresh folder trees.
- `src/lib/download.ts`: bounded memory sinks, native disk writers, streaming ZIP.
- `src/App.tsx`: sender/recipient workflows and responsive console UI.

Tailcat is pinned to commit `e00cdde6ff787f801361ff85ed085775c775d4c5` (2026-11-05), including its WireGuard preshared-key address capability. Upstream build tags omit unused features; local tags additionally omit command execution and Tailcat's SSH/SFTP servers. An SSH/SFTP client is compiled into WASM for CLI receiving and explicit uploads. The matching Go runtime and compressed WASM receive a shared content version during the build. The compiled app requests that exact pair; `npm run check:dist` verifies its hash. Generated names and build metadata remain ignored by Git. See `SECURITY.md`, `TESTING.md`, and `THIRD_PARTY_NOTICES.md`.

## Before your first public commit

No application secrets are required. Keep personal files, real share invitations, local credentials, and test captures out of the repository. The ignore rules exclude environment files, private keys, local tool/editor state, generated output, and test artifacts. Do not force-add those files. Required third-party license credits are intentionally retained.

After initializing your repository, set its commit identity **before making the first commit**. Git embeds author/committer names and email addresses in history; ignoring files does not hide them. Replace both placeholders with a public display name and the exact GitHub-provided noreply address from your account's email settings:

```sh
git config user.name "YOUR_PUBLIC_DISPLAY_NAME"
git config user.email "YOUR_GITHUB_NOREPLY_ADDRESS"
```

See GitHub's [commit email privacy instructions](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address). These commands apply to this repository only. Changing them later does not change existing commits.

After staging the intended files, inspect the staged list and diff, then scan them before committing:

```sh
git diff --cached --name-only
git diff --cached --check
git diff --cached
go run github.com/zricethezav/gitleaks/v8@v8.30.1 git --pre-commit --staged --redact --no-banner --ignore-gitleaks-allow --max-decode-depth 2 --config .gitleaks.toml
```

The scanner combines standard secret patterns with rules for literal TailShare invitations and personal home-directory paths. It cannot identify every form of personal information, so review file names and prose too. GitHub CI repeats a source snapshot scan, scans production assets, and separately checks readable strings extracted from the WASM binary. For a local or Cloudflare deployment, also run these commands in Bash (the final command uses `gzip` and `strings`):

```sh
npm run check:dist
go run github.com/zricethezav/gitleaks/v8@v8.30.1 dir --redact --no-banner --ignore-gitleaks-allow --max-decode-depth 2 --max-archive-depth 2 --config .gitleaks.toml dist
set -o pipefail
gzip -dc dist/transport/tailcat-*.wasm.gz | strings | go run github.com/zricethezav/gitleaks/v8@v8.30.1 stdin --redact --no-banner --ignore-gitleaks-allow --max-decode-depth 2 --config .gitleaks.toml
```

## Deploy to GitHub Pages

The repository includes [Checks and GitHub Pages](.github/workflows/pages.yml). It scans source and production assets for secrets, builds the Go/WASM transport from source, runs unit tests, validates `dist/`, and runs production browser checks before publishing. Node is pinned in `.node-version`; Go comes from `transport/go.mod`. Action revisions are pinned to verified commits, build jobs have read-only repository access, and only the deployment job has Pages/OIDC write permissions.

1. Push this source tree to a GitHub repository, including `package-lock.json`, `transport/go.sum`, `.node-version`, and `.github/workflows/pages.yml`. Generated `dist/`, `node_modules/`, and WASM build outputs stay ignored; CI regenerates them.
2. In the repository, open **Settings → Pages → Build and deployment → Source**, and select **GitHub Actions**. Configure the `github-pages` environment to allow your default branch. This is the one-time [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
3. Push to the repository's default branch, or run **Actions → Checks and GitHub Pages → Run workflow** on that branch. Pull requests and other branches run checks but do not publish. The deployment URL appears in the workflow's environment output.
4. For an optional real-network acceptance run, enable **relay_tests** when running the workflow manually. This uses generated test files and public DERP relays; normal CI initializes real WASM without depending on relay availability.

The same bundle works at `https://OWNER.github.io/REPOSITORY/`, a user/organization Pages root, or a custom domain. Vite emits relative URLs, including the WASM loader; no repository-name substitution is needed. Use the trailing slash for a project URL. Configure custom domains in GitHub's Pages settings, not by editing invitations. The workflow follows GitHub's [custom Pages workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) artifact/deployment model.

GitHub Pages does not apply the Cloudflare `_headers` rules. The HTML's CSP and no-referrer meta policy still apply to the page, but headers-only protections such as `frame-ancestors` and `X-Frame-Options` require a host that supports response headers. A URL-loaded worker also needs its own CSP response header; it does not inherit the page's meta CSP. Cloudflare Pages applies the included rules to both the page and worker script. On GitHub Pages the worker's network activity is governed by the application code without that additional CSP restriction. See [SECURITY.md](SECURITY.md).

## Deploy to Cloudflare Pages

### Automatic deployment from Git

Connect the same repository as a **Pages** project in Cloudflare's **Workers & Pages** dashboard. Choose Git integration and your production branch. Cloudflare can build and deploy on pushes independently of GitHub Pages; neither deployment needs an application server or Pages Functions. See Cloudflare's [Git integration guide](https://developers.cloudflare.com/pages/get-started/git-integration/).

Use these project settings:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Root directory | Repository root (leave blank) |
| Build command | `npm ci && npm test && npm run build && npm run check:dist` |
| Build output directory | `dist` |
| `NODE_VERSION` | `24.19.0` (also recorded in `.node-version`) |
| `GO_VERSION` | `1.27.4` (match `transport/go.mod`) |
| `SKIP_DEPENDENCY_INSTALL` | `true` (the build command runs `npm ci`) |

Set the environment variables for both production and preview builds. The [build image settings](https://developers.cloudflare.com/pages/configuration/build-image/) support Node/Go overrides and skipping automatic installation; the [build configuration guide](https://developers.cloudflare.com/pages/configuration/build-configuration/) explains output directories. Enable the project's build cache to reuse dependencies. Go is needed during the build only.

Save and deploy. Cloudflare provides the project's HTTPS `pages.dev` URL; custom domains can be added in that project's settings. This build command runs unit and bundle checks; GitHub Actions additionally runs the browser suite. If you need Cloudflare deployments gated on those GitHub browser checks, protect the production branch with required checks before merging.

### Upload a local build

For deployments you trigger yourself, create a Direct Upload Pages project and upload `dist/` with Wrangler:

```sh
npm ci
npm test
npm run build
npm run check:dist
npx wrangler@4 login
npx wrangler@4 pages project create tailshare --production-branch main
npx wrangler@4 pages deploy dist --project-name tailshare --branch main
```

Replace `tailshare` and `main` with your Cloudflare project name and production branch. Run project creation only once; use the deploy command for later releases. Authentication stays in Wrangler, outside the site's assets. Cloudflare's [Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/) explains that a Direct Upload project cannot later be switched to Git integration; create a separate Git-integrated project if you need that workflow.

### Static hosting checks

- Upload **only `dist/`**. Keep the versioned `transport/tailcat-<version>.wasm.gz`, matching `wasm_exec-<version>.js`, worker bundle, fonts, licenses, and `_headers` together. Do not deploy `transport/.build/tailcat.wasm` or the repository root.
- `npm run check:dist` rejects unexpected public assets, source maps, and symlinks. Vite copies files from `public/` even when Git ignores them. Review any intentional new asset and update the explicit list in `scripts/check-dist.mjs` before deploying it.
- `public/_headers` becomes `dist/_headers`; Cloudflare [applies it to static responses](https://developers.cloudflare.com/pages/configuration/headers/). It includes CSP, framing protection, no-referrer, and permissions restrictions. No Worker or server middleware is needed.
- The compressed WASM fits Cloudflare's [25 MiB per-asset limit](https://developers.cloudflare.com/pages/platform/limits/). `npm run check:dist` verifies that limit for every deployed file. The loader accepts either raw gzip bytes or a response already decompressed by the host; do not rename it or replace it with an HTML fallback.
- After publishing, open the HTTPS site in two browsers and transfer a small synthetic file. Verify link confirmation, key-only browsing, and a one-use share. Local tests do not replace this check against your actual hosting configuration.
- These hosts serve application assets only. Expiry and use counts are enforced in the sender's browser; no hosting database, cloud secret, or uploaded-file storage is introduced.
