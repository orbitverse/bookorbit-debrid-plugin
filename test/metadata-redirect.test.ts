import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import type {
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

const hash = "a".repeat(40);
const query: PluginReleaseQuery = {
  title: "Book",
  author: null,
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: null,
  limit: 20,
};
const config: PluginIndexerConfig = {
  id: 1,
  name: "Books",
  baseUrl: "http://indexer.example:9696",
  allowPrivateAddress: true,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/3/api" },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER",
    debrid: { provider: "torbox", key: "SYNTHETIC_PROVIDER" },
  }),
};
// The download link redirects to itself `redirects` times, then to a magnet.
function fixture(redirects: number) {
  let downloads = 0;
  const host: PluginHost = {
    async fetch(input) {
      const url = new URL(input);
      if (url.pathname === "/3/api")
        return new Response(
          '<rss><channel><title>Books</title><item><title>Book</title><enclosure url="/3/download?link=book"/></item></channel></rss>',
        );
      if (url.pathname === "/3/download") {
        const location =
          downloads++ < redirects
            ? `/3/download?link=book&hop=${downloads}`
            : `magnet:?xt=urn:btih:${hash}`;
        return new Response(null, { status: 302, headers: { location } });
      }
      assert.equal(url.origin, "https://api.torbox.app");
      assert(url.pathname.endsWith("/checkcached"));
      return Response.json({
        success: true,
        data: {
          [hash]: {
            hash,
            name: "Book",
            files: [{ name: "Book.epub", size: 100 }],
          },
        },
      });
    },
    logger: { log() {}, warn() {} },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  return { host, downloads: () => downloads };
}
const search = (host: PluginHost) =>
  plugin.search(query, config, host, AbortSignal.timeout(1000));

test("a magnet is accepted after three same-origin redirects", async () => {
  const f = fixture(3);
  const releases = await search(f.host);
  assert.equal(releases.length, 1);
  assert.equal(JSON.parse(releases[0].guid).hash, hash);
  assert.equal(f.downloads(), 4);
});

test("a fourth redirect is still rejected without another request", async () => {
  const f = fixture(4);
  assert.deepEqual(await search(f.host), []);
  assert.equal(f.downloads(), 4);
});
