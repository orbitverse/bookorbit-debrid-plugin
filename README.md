# BookOrbit Debrid

Find ebooks and audiobooks through your indexers and debrid account.
BookOrbit downloads the files directly; you do not need a local torrent client.

**Early preview:** Supports TorBox, EasyDebrid, Real-Debrid and Debrid-Link. Only TorBox has been verified with live BookOrbit downloads.

## Setup

1. Build `dist/index.mjs` below, then upload it in BookOrbit under **Settings → Server → Requests → Install a plugin**.
2. Add **BookOrbit Debrid** as a source. Set **Base URL** to your Prowlarr or Jackett server, such as `http://prowlarr:9696`. Enable **Allow private addresses** for a local server.
3. For Prowlarr, leave **Torznab API paths** blank: enabled public ebook and audiobook indexers are found automatically. For Jackett, paste the paths from your chosen indexers' Torznab URLs, separated by commas, without query strings. You can also enter paths such as `/1/api,/2/api` to choose specific Prowlarr indexers.
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

Choose your provider in the JSON:

| `provider`   | `key`                         | Books supported                                                      |
| ------------ | ----------------------------- | -------------------------------------------------------------------- |
| `torbox`     | TorBox API key                | Ebooks, single-file and multi-track audiobooks                       |
| `easydebrid` | EasyDebrid OAuth access token | Cached ebooks and single-file audiobooks                             |
| `realdebrid` | Real-Debrid API token         | Ebooks and single-file audiobooks already downloaded in your account |
| `debridlink` | Debrid-Link API/OAuth token   | Ebooks and single-file audiobooks already downloaded in your account |

Real-Debrid and Debrid-Link search your account, not the shared cache. Use
preparation below to add a new torrent. This preview supports accounts with at
most 100 torrents.

TorBox download links also contain your API key. BookOrbit keeps the link on
your server while downloading; database backups may retain it. Keep those
links and backups private.

Searches show ready files by default. Selecting a result rechecks its availability.

With TorBox, Real-Debrid or Debrid-Link, you can enable **Show uncached torrents**. Results marked **Prepare**
need an availability check and may need fetching first. Clicking **View files** or **Download release** may start
preparation in your account; automatic grabs can also start it. One preparation candidate is offered only when no ready books were found. Search again later and select a ready file to download;
BookOrbit will not finish the request automatically. Your provider's account limits
still apply. Files are checked before delivery, so a preparation result may turn out
not to contain a supported book. Real-Debrid may need you to select files in its
website when several book files are available.

Ebooks retain their separate formats. Audiobooks can be a single audio file or
a numbered track set in one matching folder, delivered together as ZIP.
If an imported audiobook shows the wrong duration or missing chapters, scan its library once.
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
