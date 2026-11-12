# TailShare
<!-- impeccable:product-schema 1 -->
## Platform
web
## Stack
Delegated by the user: React and TypeScript with Vite, compiled to static assets. Go/WASM Tailcat transport. No application backend or server-side file storage.
## Users
People sharing selected local files or a directory with a trusted recipient through a separate trusted messaging channel.
## Product Purpose
Select files or a directory and create an ephemeral share link/key. Links show a file-list confirmation and start downloading the full share when confirmed; key-only connections open the file browser. The same receive field accepts a bare Tailcat CLI key for read-only browsing and downloading from `tailcat serve files`. CLI browsing opens the first root page, then loads folders and further pages on demand. Recipients can download separately or as ZIP; CLI folder downloads include unopened descendants, with the current folder used when nothing is selected.
## Operating Context
Browser senders can also choose a CLI destination, paste a `tailcat recv` key, and explicitly send separate files, a streaming ZIP, or a folder tree with `--accept-dirs`. Completed and partial files may remain after interruption; no automatic retry or remote cleanup is promised.

Both endpoints stay online: two open browsers, or an open browser and a running sender/receiver CLI. Browser Tailcat uses end-to-end encrypted DERP relay connections. Static assets can be hosted on any HTTPS static host. Chrome is the priority, with Firefox, Safari, and mobile supported using capability-based fallbacks from day one.
## Capabilities and Constraints
Only user-selected files are exposed. Credentials stay in URL fragments and memory. Sender can revoke a share, choose timed expiry, keep it available while the tab stays open, or limit authenticated recipient connections; exhausted invitations allow current recipients to finish. Directory selection depends on the browser's picker support. Direct-to-disk saving is progressive enhancement; other browsers have a visible memory limit. No account, telemetry, cloud file store, or background upload.

CLI receiving has no total directory or served-tree entry cap. Pages, cached metadata, directory cursors, and request time are bounded; filtering, selection, and displayed counts apply to the current page. Listings are live and can be refreshed without reconnecting. Browser-origin selections and uploads retain their 10,000-entry limit. ZIP downloads retain the 4 GB bound, 65,535-entry maximum, and 8 MiB metadata budget; memory-only downloads retain the 256 MB limit. Recursive CLI downloads discover entries incrementally, preserve empty directories where the destination supports them, and do not promise a complete size preflight, snapshot, automatic retry, or resume.
## Brand Commitments
Retro 1980s/1990s futuristic cyberpunk: neon magenta, cyan, bright orange. Working interface built directly, as confirmed by the user.
## Product Principles
Explicit sharing boundaries; honest network and transfer state; bounded memory; readable and accessible controls; no invented transfer statistics.
