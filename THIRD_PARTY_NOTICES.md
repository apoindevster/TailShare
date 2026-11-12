# Third-party notices

TailShare uses the following open-source components. Their license text is distributed by each installed package/module and remains authoritative.

- [Tailcat](https://github.com/tailscale/tailcat), Tailscale Inc & contributors, BSD-3-Clause. Pinned in `transport/go.mod`; license copied to `transport/LICENSE.tailcat`. Browser bridge API design informed by upstream Tailcat and Tailcatchat.
- [Tailcatchat](https://github.com/tailscale/tailcatchat), BSD-3-Clause. Reference project; license retained as `transport/LICENSE.tailcatchat`.
- [Go](https://go.dev/), BSD-3-Clause. The build copies `wasm_exec.js` and the Go license into `public/transport/`.
- React / React DOM, MIT.
- Vite, Vitest, TypeScript and Playwright: see their package licenses (MIT / Apache-2.0 as applicable).
- fflate, MIT. Used for streamed ZIP creation, never untrusted archive extraction.
- @noble/hashes, MIT. Incremental SHA-256.
- github.com/pkg/sftp, BSD-2-Clause; golang.org/x/crypto and golang.org/x/text, BSD-3-Clause. CLI transfers use these Go modules for SFTP, SSH, and Unicode normalization; the build includes their license files in `public/THIRD_PARTY_LICENSES.txt`.
- Lucide, ISC. Interface icons.
- Chakra Petch and IBM Plex Sans, SIL Open Font License. Self-hosted through @fontsource.

Transitive Go dependency licenses remain in their module distributions. A distributor should retain all required notices when packaging or modifying dependencies.
