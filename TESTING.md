# Verification record

Verified locally on 2026-11-12 using Node 24, Go 1.27.4, and Playwright 1.65.0.

The latest CLI pagination checks are recorded under **On-demand CLI directories (2026-11-13)** below. Earlier records retain their original scope and date.

| Check | Result |
| --- | --- |
| `npm run build` | Passed; Go/WASM plus strict TypeScript plus static Vite production output |
| `npm test` | 103 tests passed, including browser share security/lifetimes, publication boundaries, CLI routing/transfers, worker RPC, progress coalescing, wake-lock lifecycle, and streaming ZIP output; also passed from a clean source snapshot before generated transport metadata exists |
| `cd transport && go test -race ./...` | 14 native SSH/SFTP tests passed, including binary/empty files, symlink replacements, file changes/truncation, cancellation, packet/path limits, upload lengths, and exclusive writes |
| `TAILSHARE_NETWORK=1 npm run test:e2e` plus targeted reruns | 71 distinct checks passed across all five browser profiles, including actual tailcat serve and tailcat recv transfers and 25 optimization checks. Four duplicate screenshot cases and five opt-in benchmark cases intentionally skipped in the ordinary suite |
| Desktop/mobile screenshot inspection | 1440px/390px application; 1280px/390px download prompt, expiry controls, CLI entry/connected/recovery, CLI upload, and transport loading/error/active wake-lock captures verified; real transfers passed in every browser profile |
| Impeccable finish review | Earlier accessibility/copy findings resolved. Link-confirmation, expiry, CLI receive/upload, and optimization reviews returned disposition ship. The optimization review checked eight desktop/mobile captures and sampled source; the documenter updated the surface story while preserving the design system. Generic fresh subagents used the fallback reviewer/documenter contracts |
| `npm audit` | Zero reported vulnerabilities, including development dependencies |
| Go `govulncheck`, js/wasm with shipping build tags | Zero reachable vulnerabilities; three advisories exist in required dependency modules whose affected packages are not imported/called by this application |
| `npm run check:dist` | Passed: approved asset paths only, relative entrypoint URLs, production CSP, licenses, valid compressed WASM, no symlinks, and Cloudflare per-asset size limits |
| `actionlint` v1.7.7 | GitHub Pages workflow passed syntax, expression, and permission-context checks locally |
| Gitleaks v8.30.1 | No findings in the prospective source snapshot, production text assets, or readable strings extracted from decompressed WASM |

The deployment workflow and Cloudflare commands are prepared, but no remote GitHub Actions run or hosted deployment has been performed from this workspace. Provider account/repository setup and a post-deployment check remain deployment steps.

## Publication review

The review covered the 50 files eligible for a first commit, configuration and dependency lockfiles, public assets, and the 70-file production bundle. Manual review and pattern checks found no private credentials, personal email addresses in source, developer home paths, developer name, or literal share credentials in the publishable files. Checks included the raw decompressed WASM bytes; a separate Gitleaks pass scanned its readable strings because binary files are normally skipped by that tool. Required public third-party license credits remain intact.

The review added ignore rules for local secrets and tool state, CI secret/privacy scans, and an explicit deployment asset allowlist. Eight publication tests verify the expected bundle and reject environment files, private-key files, personal-image directories, source maps, Git metadata, symlinks, and mismatched transport/runtime versions. Additional local probes confirmed eleven representative sensitive/artifact paths are ignored and five synthetic scanner fixtures are detected, covering an invitation, a token, and Linux/macOS/Windows home paths. Scanner fixtures and reports were kept outside the project.

The initial publication review used an isolated temporary repository. At the user’s later request, the project was initialized on `main` and saved in WIP commit `9db6b5b` before optimization work, using the neutral local identity `TailShare contributors <tailshare@localhost>`. No push or deployment has been performed. Choose your intended public identity before subsequent commits if you want GitHub attribution. The review does not cover future edits, older Git history, or an independently certified security audit.

## CLI interoperability extension

`npm run build:test-cli` installs the exact Tailcat version from `transport/go.mod` into ignored `transport/.build/`. The CLI browser test starts the actual executable with an ephemeral key, a temporary SSH configuration directory, and a synthetic read-only directory. In each of the five browser profiles it pastes the CLI key into the existing receive field, verifies browse-first behavior with no automatic download, browses nested/empty folders, downloads a file, verifies ZIP contents including binary and empty files, confirms symbolic links are skipped, checks the key stays out of HTTP request URLs, and disconnects. The process is stopped in cleanup. Regular CI keeps relay tests opt-in; a manual relay run builds the pinned CLI automatically.

Native Go tests use a loopback SSH/SFTP server to exercise the production adapter without public relays. TypeScript tests verify catalog validation, key routing without authentication downgrade, unknown-file rejection, complete and truncated transfers, cancellation, changed-file rejection before commit, and compatibility with the existing ZIP writer. CLI receiving relies on authenticated SFTP plus size/mtime checks, not a sender-provided file digest.

### Large-directory listing regression (2026-11-13)

This was an intermediate fix. The on-demand directory implementation below supersedes the whole-tree scan and its total-entry limit.

The command `tailcat serve --key=new --files=.` was tested with an installed v0.7.0 CLI and synthetic directories. A small share connected and downloaded successfully before the fix. With 200 subfolders containing one file each, the serial directory scan failed after 60.49 seconds. Reading up to eight folders concurrently connected the same fixture in 9.85 seconds and verified a downloaded file's bytes. These are individual public-relay observations, not throughput guarantees. The existing entry, metadata, path, and connection-time limits remain in effect.

The real CLI browser regression now serves a relative directory with `--files=.:ro`, without a trailing `files` argument, and includes 200 nested folders plus a file in the last folder. All five browser profiles passed browsing, file/ZIP content checks, and disconnect. The ten existing CLI-upload and upload-cancellation checks also passed, for 15 checks in this targeted run. This does not certify physical mobile devices or unlimited project/home directories.

All 106 TypeScript tests passed, including an unanswered listing, cancellation without a worker response, ignored late metadata, and synchronous bridge failures. All 16 native Go tests passed with the race detector. The new controllable SFTP peer verifies directory requests are pipelined, entries and IDs survive the merge, and cancellation/deadlines interrupt both an unresponsive directory listing and ancestor-stat operation. Production build and asset checks were repeated after the fix. Earlier full-suite and security-scan results above retain their original scope and date.

The publication scan was repeated for 57 commit-eligible files after CLI receiving, 62 after CLI uploading, and 71 after optimization, along with production assets and extracted WASM strings. New synthetic probes verify detection of bare CLI addresses and persisted private node keys. No personal developer identifiers or credentials were found; all probe data remains outside the project. Required public dependency copyright credits remain. The new SSH/SFTP imports were included in the js/wasm vulnerability scan: zero reachable vulnerabilities, with the same three advisories confined to unused dependency-module code.

### On-demand CLI directories (2026-11-13)

CLI receiving now opens only the root's first page on connection and lists other folders when opened. A directory page processes at most 128 names; the pinned Tailcat CLI normally returns 100 names per response. There is no total CLI catalog-entry cap. Recent pages are cached, older pages are reread when needed, and Refresh folder starts a new listing. Filtering and selection apply to the visible page. Folder downloads walk unopened descendants incrementally. Browser-origin selections and CLI upload manifests still have their existing 10,000-entry cap; ZIP, path, packet, timeout, and browser-memory limits remain separate bounds.

All 117 TypeScript tests and 18 native Go tests passed, with the Go race detector enabled. New tests traverse all 10,050 file entries through the paged client, build and inspect a 10,050-file ZIP without a whole-tree manifest, verify bounded cache rereads and cursor cleanup, and recover from a removed or unreadable folder. Native tests exercise a real loopback SSH/SFTP service with more than 10,000 children, session-bound entry capabilities, cursor replay rejection, symlink replacement, malformed directory responses, and cancellation of an unresponsive peer. ZIP duplicate paths spanning pages abort the archive; separate-file destination tests verify save-prompt timing, cancellation before traversal, and refusal to overwrite a previous output file.

The full production network suite passed **71 checks across all five browser profiles**, with nine intentional skips (four duplicate screenshot checks and five opt-in benchmarks). Each CLI receive check connects to a synthetic share containing a folder with 10,050 subfolders, opens it, changes pages, filters, revisits a page, and refreshes. It then removes that synthetic large folder before verifying the smaller recursive ZIP fixture, including a file in an unopened nested folder. The native and unit tests enumerate every entry; the browser test samples pages rather than clicking through all 10,050 folders. Browser-to-browser and browser-to-CLI transfers, expiry, cancellation, static subpath hosting, and worker/wake-lock behavior also passed. These results cover browser emulation, not physical phones.

A separate Chromium check against the installed Tailcat v0.7.0 used the exact `tailcat serve --key=new --files=.` command and verified downloaded bytes. A small synthetic directory connected in 1.82 seconds; a directory with 200 subfolders containing one file each showed its initial page in 3.33 seconds. The earlier 9.85-second result above waited for the entire 200-folder catalog; this implementation deliberately defers that work. These are individual public-relay observations, not controlled throughput measurements or guaranteed timings.

The production WASM/TypeScript build and distribution allowlist checks passed. Publication scans found no secrets or personal paths in the 76 eligible source files, static production assets, or readable strings extracted from decompressed WASM. No dependencies were added for pagination. Desktop and mobile captures are recorded as `.impeccable/review/cli-paged-chromium.png` and `.impeccable/review/cli-paged-mobile-safari.png`; the pagination preserves the incumbent console design.

A fresh finish reviewer identified retained list scrolling between pages. Successful page/folder/refresh navigation now resets the file list to its first row. The rebuilt production app passed all five CLI browser checks again, including assertions after scrolling to the bottom and choosing Next, Previous, and Refresh. The reviewer scored that fix resolved with disposition `ship`; this verdict covers the named fix. A fresh generic agent used the skill's fallback reviewer contract, and the following documenter pass preserves the existing design system.

## What the tests exercise

The browser-to-CLI extension adds real `tailcat recv` inbox tests for separate files, streaming ZIP, and `--accept-dirs` folder trees. They verify content and paths on disk, preservation of a pre-existing inbox file, unique flat names, no sending just from pasting a key, clearing the key after starting, rejection of tree mode on a flat inbox, and absence of keys in HTTP URLs. A controlled pause after an actual SFTP write exercises cancellation and checks that only one 256 KiB partial batch remains, with accurate recovery guidance. All fixtures are synthetic. Native tests additionally exercise exclusive creation against existing files and symlinks, invalid plans/paths, unknown IDs, length/chunk limits, and writes after cancellation. TypeScript tests verify preflight selection checks, bounded streaming, ZIP contents, failed final acknowledgements, and cancellation during WASM loading or a write.

The unit suite covers selected-file boundaries, nested folder enumeration, unsafe/traversal/device paths, duplicate names, integer bounds, manifest and frame limits, fragment credentials, token generation, fragmented binary transfers, empty files, incorrect authentication, unselected file requests, revocation, expiry, oversized or altered content, SHA-256 verification, ZIP paths/contents, memory limits, cancellation cleanup, and native writable-stream adapters.

Each browser-to-browser network test starts a sender and a recipient in independent browser contexts and uses the compiled WASM against public DERP relays. Only generated synthetic files are shared. Tests exercise usage-limited shares over real WASM: the final admitted recipient can download repeatedly, new key connections are refused, and an explicit disconnect closes an exhausted share. Never-expiring shares are also exercised. Tests check link-triggered file-list confirmation, keyboard focus containment and dismissal, key-only browsing without downloads, confirmed ZIP/separate/single-file downloads, and pasted-link behavior. They also browse nested directories; verify text, binary and empty files; inspect downloaded ZIP bytes; check removal of the fragment and absence of its key in HTTP URLs; stop sharing; and verify a subsequent download fails. UI tests exercise selection, search, removal, invalid invitations, and horizontal overflow checks.

A separate offline browser check serves the exact production bytes under a GitHub-style project subpath, initializes the real WASM while blocking relay-map requests, and checks that assets stay under the subpath. This runs in regular CI without public relay dependencies.

Profiles: desktop Chromium, Firefox, WebKit, Pixel 7 / Chrome emulation, and iPhone 13 / Safari emulation. Native picker adapters are tested with fake writable handles; real network browser tests deliberately exercise the Blob-download fallback to avoid unattended native save dialogs.

## Optimization verification and measurements

The optimization checks cover worker preparation without relay traffic, a failed runtime download and retry, a host that already decompresses the WASM response, worker termination/recovery, matching runtime/WASM versions, stable action positioning when the engine becomes ready, and optional wake-lock feedback/release. The failure-injection harness was corrected to schedule termination after its debugger call returns. A later WebKit trace identified a lost click when removing the loading message changed the page's scroll limit; the status now remains in place and a regression test checks the action's position at that scroll limit. The final 25 optimization checks passed in all five browser profiles. Wake-lock tests use synthetic handles, including pending acquisition, visibility changes, denial, and system release. They do not establish physical-device behavior. Native tests verify varied binary content across multiple pipelined SFTP batches. Existing fragmented-transfer tests exercise the coalesced browser frames without changing their wire format.

The opt-in `performance.spec.ts` benchmark verifies output bytes while measuring a 4 MiB file and sixteen 16 KiB files through public DERP relays. The baseline used the WIP production build; the final run used worker transport, bounded SFTP pipelining, coalesced browser frame writes, and throttled progress. Both endpoints ran on the same development machine in Chromium. These are single-run elapsed observations, not controlled throughput guarantees or statistically established improvements.

| Operation | Before (seconds) | Final run (seconds) |
| --- | ---: | ---: |
| Browser share startup after selecting files | 0.382 | 0.862 |
| Browser → browser, 4 MiB | 4.239 | 3.861 |
| CLI → browser, 4 MiB | 10.533 | 8.245 |
| Browser → CLI, 4 MiB | 10.440 | 7.393 |
| Browser → browser, sixteen files as ZIP | 5.826 | 4.881 |
| CLI → browser, sixteen files as ZIP | 9.312 | 9.342 |
| Browser → CLI, sixteen separate files | 4.890 | 4.886 |

The receiving ZIP measurements include selecting the sixteen checkboxes; CLI upload measurements include connection setup. Startup depends on how much prewarming completed and on relay setup. Many-small-file results are therefore not directly comparable across transfer directions. An intermediate run ranged from 3.866 seconds for CLI upload to 7.414 seconds for browser-to-browser transfer; this prompted coalescing each browser frame's header and payload into one worker write. Public-relay variation prevents attributing the final timing change solely to that adjustment. No run showed main-thread tasks over 50 ms; the final run's largest frame gap was about 16.8 ms. This desktop workload does not demonstrate a measurable UI improvement from moving transport work off-thread, nor does it predict phone performance.

## Limits of this verification

Mobile emulation does not certify physical phones, OS file pickers, screen-lock behavior, background execution, or device memory limits. The tests use small synthetic files rather than multi-gigabyte transfers. They do not constitute an independent security audit or guarantee relay availability. Both endpoints ran on one development machine through real relays; separate physical networks were not tested. The transfer protocol and static build are ready for device-level acceptance testing.

The UI screenshots are in `.impeccable/review/`; Playwright reports and traces are ignored build artifacts. Test traces can contain ephemeral synthetic-test invitations and should not be generated using personal files.
