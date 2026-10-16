# Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely. Consult the installed version-matched Effect source for unfamiliar APIs.

# Plugin rules

- Every network request uses `host.fetch`; credentials only in the encrypted API key JSON. Never log keys or signed download URLs.
- Search is read-only: no add, queue, upload or link generation. Ready-file resolution retains the cached-only guard. With Show uncached downloads enabled, resolving a clearly labeled preparation result may start an account transfer (View files also resolves). Reconcile existing jobs before adding; never blindly retry mutations, invent a pending URL or promise automatic completion.
- Treat indexers and provider responses as untrusted. No arbitrary URLs from release identifiers, no authenticated redirects.
- Keep complete audiobook tracks together. Never deliver one chapter as the whole book. Exclude ambiguous archives and multi-book bundles.
- Keep provider protocols in their module, matching/file selection pure, and the BookOrbit adapter small. Avoid abstractions for unsupported providers.
- Run `pnpm check` before delivering the single `dist/index.mjs` file. Tests use synthetic accounts and fixture responses. Live acquisition is a separate check.
- README is for casual users. Keep research and development-history notes out of public documentation.
- To release, bump `package.json` and merge a passing PR. Actions signs and publishes from the main-only `plugin-signing` environment.
