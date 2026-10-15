# BookOrbit Debrid

Find cached ebooks and audiobooks through your indexers and debrid account.
BookOrbit downloads the files directly; you do not need a local torrent client.

**Early preview:** TorBox is the first provider. Live search is verified;
downloads and BookOrbit imports are still being tested.

## Setup

1. Build `dist/index.mjs` below, then upload it in BookOrbit under **Settings → Server → Requests → Install a plugin**.
2. Add **BookOrbit Debrid** as a source. Set **Base URL** to your Prowlarr or Jackett server, such as `http://prowlarr:9696`. Enable **Allow private addresses** for a local server.
3. In **Torznab API paths**, enter the paths from your public book indexers, separated by commas. For Prowlarr, these look like `/1/api,/2/api`. For Jackett, copy the path from each indexer's Torznab feed URL. Omit the query string.
4. Paste this JSON into **API key**, replace the placeholders, save, and run **Test connection**:

```json
{
  "indexerKey": "YOUR-PROWLARR-OR-JACKETT-API-KEY",
  "debrid": {
    "provider": "torbox",
    "key": "YOUR-TORBOX-API-KEY"
  }
}
```

BookOrbit stores these credentials encrypted. Your server needs
`BOOK_REQUEST_ENCRYPTION_KEY` configured.

TorBox download links also contain your API key. BookOrbit keeps the link on
your server while downloading; database backups may retain it. Keep those
links and backups private.

Searches show cached files only. Selecting a result rechecks its availability;
if it has left the cache, search again. Uncached torrents are never queued.
Your provider's account limits still apply.

Ebooks retain their separate formats. Audiobooks can be a single audio file or
a numbered track set in one matching folder, delivered together as ZIP.
Ambiguous archives and mixed book collections are omitted. Use public indexers
that return an infohash or magnet; private and hashless results are not supported.

## Build

With Node.js 22 or newer and pnpm installed:

```sh
pnpm install
pnpm check
```

Upload **`dist/index.mjs`**. `pnpm build` rebuilds it without running checks.

Copyright © 2026 campfireshuffle. AGPL-3.0 licensed. Vendored BookOrbit types retain their upstream notice in `vendor/`.
