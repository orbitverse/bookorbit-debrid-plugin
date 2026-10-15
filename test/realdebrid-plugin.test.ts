import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import type {
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

const hash = "e".repeat(40);
const key = "SYNTHETIC_RD_ACCOUNT_TOKEN";
const config: PluginIndexerConfig = {
  id: 1,
  name: "Debrid",
  baseUrl: "https://indexer.example",
  allowPrivateAddress: false,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/1/api", prepareUncached: true },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER_KEY",
    debrid: { provider: "realdebrid", key },
  }),
};
const query: PluginReleaseQuery = {
  title: "The Little Prince",
  author: null,
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: null,
  limit: 20,
};
function fixture(initial: "absent" | "downloaded" = "downloaded") {
  let status: string = initial;
  const calls: string[] = [];
  const info = () => ({
    id: "rd1",
    hash,
    filename: "The Little Prince",
    bytes: 5000,
    progress: status === "downloaded" ? 100 : 0,
    status,
    files:
      status === "magnet_conversion"
        ? []
        : [
            {
              id: 1,
              path: "/The Little Prince.epub",
              bytes: 5000,
              selected:
                status === "downloaded" || status === "downloading" ? 1 : 0,
            },
          ],
    links:
      status === "downloaded" ? ["https://hoster.example/opaque-file"] : [],
  });
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(init?.redirect, "manual");
      assert(!input.includes(key));
      calls.push(url.pathname);
      if (url.hostname === "indexer.example")
        return new Response(
          `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Books</title><item><title>The Little Prince</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`,
        );
      assert.equal(url.origin, "https://api.real-debrid.com");
      assert.equal(init?.headers?.Authorization, `Bearer ${key}`);
      if (url.pathname === "/rest/1.0/torrents")
        return Response.json(status === "absent" ? [] : [info()]);
      if (url.pathname === "/rest/1.0/torrents/info/rd1")
        return Response.json(info());
      if (url.pathname === "/rest/1.0/torrents/addMagnet") {
        assert.equal(
          new URLSearchParams(init!.body!).get("magnet"),
          `magnet:?xt=urn:btih:${hash}`,
        );
        status = "magnet_conversion";
        return Response.json(
          {
            id: "rd1",
            uri: "https://api.real-debrid.com/rest/1.0/torrents/info/rd1",
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/rest/1.0/torrents/selectFiles/rd1") {
        assert.equal(new URLSearchParams(init!.body!).get("files"), "1");
        status = "downloading";
        return new Response(null, { status: 204 });
      }
      assert.equal(url.pathname, "/rest/1.0/unrestrict/link");
      assert.equal(
        new URLSearchParams(init!.body!).get("link"),
        "https://hoster.example/opaque-file",
      );
      return Response.json({
        id: "link1",
        filename: "The Little Prince.epub",
        filesize: 5000,
        download: "https://cdn.example/book.epub?ticket=opaque",
      });
    },
    logger: { log() {}, warn() {} },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("Unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  return {
    host,
    calls,
    phase: (phase: string) => {
      status = phase;
    },
  };
}
const signal = () => new AbortController().signal;

test("Real-Debrid plugin returns ready account files and resolves without adding or reselecting", async () => {
  const f = fixture();
  const [release] = await plugin.search(query, config, f.host, signal());
  assert.match(release.title, /Real-Debrid account/);
  assert.equal(release.format, "epub");
  assert(!release.guid.includes(key));
  assert(
    !f.calls.some((path) => /addMagnet|selectFiles|unrestrict/.test(path)),
  );
  const file = await plugin.resolveFile!(release, config, f.host, signal());
  assert.equal(file.fileName, "The Little Prince.epub");
  assert.equal(file.sizeBytes, 5000);
  assert.equal(file.url, "https://cdn.example/book.epub?ticket=opaque");
  assert(!f.calls.some((path) => /addMagnet|selectFiles/.test(path)));
});

test("Real-Debrid preparation handles file selection then later delivers a ready validated file", async () => {
  const f = fixture("absent");
  const [preparation] = await plugin.search(query, config, f.host, signal());
  assert.match(preparation.title, /Prepare in Real-Debrid account/);
  assert.equal(preparation.format, undefined);
  await assert.rejects(
    plugin.resolveFile!(preparation, config, f.host, signal()),
    /Preparing/,
  );
  f.phase("waiting_files_selection");
  await assert.rejects(
    plugin.resolveFile!(preparation, config, f.host, signal()),
    /Preparing/,
  );
  await assert.rejects(
    plugin.resolveFile!(preparation, config, f.host, signal()),
    /Preparing/,
  );
  assert.equal(f.calls.filter((path) => path.endsWith("addMagnet")).length, 1);
  assert.equal(
    f.calls.filter((path) => path.includes("selectFiles")).length,
    1,
  );
  f.phase("downloaded");
  const [ready] = await plugin.search(query, config, f.host, signal());
  assert.equal(ready.format, "epub");
  assert(!ready.title.includes("Prepare"));
  const file = await plugin.resolveFile!(ready, config, f.host, signal());
  assert.equal(file.sizeBytes, 5000);
});
