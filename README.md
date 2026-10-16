# BookOrbit Debrid

Find ebooks and audiobooks through Prowlarr or Jackett and your debrid account.
BookOrbit downloads the files directly from your provider.

**Early preview:** TorBox, EasyDebrid, Real-Debrid and Debrid-Link are supported.
Only TorBox has been verified with live BookOrbit downloads.

## Install

1. Download `index.mjs` from the [latest release](https://github.com/orbitverse/bookorbit-debrid-plugin/releases/latest).
2. In BookOrbit, open **Settings → Server → Requests → Install a plugin** and upload it.
3. Add **BookOrbit Debrid** as a source and enter your Prowlarr or Jackett server address.
4. Add your account details below, save, and click **Test connection**.

For future updates, use **Check for updates** or enable **Install signed updates automatically**.

## Settings

| Setting                 | What to choose                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Base URL                | Your Prowlarr or Jackett address, such as `http://prowlarr:9696`.                            |
| Allow private addresses | Enable for a server on your local network.                                                   |
| Torznab API paths       | Leave blank for automatic public book indexer discovery in Prowlarr. Jackett setup is below. |

## Accounts

Paste this into the source’s **API key** field and replace the placeholders:

```json
{
  "indexerKey": "YOUR-PROWLARR-OR-JACKETT-API-KEY",
  "debrid": {
    "provider": "torbox",
    "key": "YOUR-TORBOX-API-KEY"
  }
}
```

Choose one provider:

| `provider`   | What to put in `key`          | Ready downloads                                            |
| ------------ | ----------------------------- | ---------------------------------------------------------- |
| `torbox`     | TorBox API key                | Cached ebooks and audiobooks, including multi-track ZIPs.  |
| `easydebrid` | EasyDebrid OAuth access token | Cached ebooks and single-file audiobooks.                  |
| `realdebrid` | Real-Debrid API token         | Ebooks and single-file audiobooks already in your account. |
| `debridlink` | Debrid-Link API/OAuth token   | Ebooks and single-file audiobooks already in your account. |

BookOrbit encrypts account details. Your server needs
`BOOK_REQUEST_ENCRYPTION_KEY` configured.

TorBox download links contain your API key. BookOrbit stores these links while
downloading, and backups may retain them. Keep your server and backups private.

## Preparing a download

With TorBox, Real-Debrid or Debrid-Link, enable the source’s uncached-results
option to find something to prepare when no ready book is available.

Results marked **Prepare** may need downloading into your debrid account first.
**View files**, **Download release**, or an automatic grab can start this step and
use your provider allowance. Search again later to download the ready book;
BookOrbit cannot finish preparation automatically.

<details>
<summary>Indexer setup and download limits</summary>

For Jackett, enter the paths from your indexers’ Torznab URLs in **Torznab API
paths**, separated by commas, without query strings. For specific Prowlarr
indexers, enter paths such as `/1/api,/2/api`.

Use public indexers that return an infohash or magnet. Private and hashless
results are not supported. Real-Debrid and Debrid-Link check your account rather
than the shared cache; accounts with more than 100 entries are not supported.

Preparation does not guarantee a supported book. Real-Debrid may ask you to
select files on its website when several book files are available.

Separate ebook formats are kept. TorBox can deliver a numbered audiobook track
set together as a ZIP; ambiguous archives and mixed book collections are skipped.
If an imported audiobook has incorrect timing or missing chapters, scan its
library once.

</details>

## Build

With Node.js 22 or newer and pnpm installed:

```sh
pnpm install
pnpm check
```

The uploadable file is `dist/index.mjs`. Use `pnpm build` to rebuild without checks.

Copyright © 2026 campfireshuffle. AGPL-3.0 licensed. Vendored BookOrbit types retain their upstream notice in `vendor/`.
