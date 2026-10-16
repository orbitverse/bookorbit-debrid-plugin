import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import type {
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

const hash = "a".repeat(40);
const q: PluginReleaseQuery = {
  title: "Dune",
  author: "Frank Herbert",
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: "en",
  limit: 20,
};
const cfg: PluginIndexerConfig = {
  id: 1,
  name: "Books",
  baseUrl: "http://indexer.example",
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER",
    debrid: { provider: "torbox", key: "SYNTHETIC_PROVIDER" },
  }),
  allowPrivateAddress: false,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/1/api" },
};
function fixture(
  options: {
    title?: string;
    author?: string;
    language?: string;
    metadata?: boolean;
    miss?: boolean;
  } = {},
) {
  const calls: URL[] = [];
  const title = options.title ?? "Dune";
  const author = options.author ?? "Frank Herbert";
  const language = options.language ?? "en";
  const host: PluginHost = {
    async fetch(input) {
      const url = new URL(input);
      calls.push(url);
      if (url.pathname === "/1/api")
        return new Response(
          `<rss><channel><title>Books</title><item><title>${title}</title><torznab:attr name="author" value="${author}"/><torznab:attr name="language" value="${language}"/>${options.metadata ? '<enclosure url="/1/download?link=book"/>' : `<torznab:attr name="infohash" value="${hash}"/>`}</item></channel></rss>`,
        );
      if (url.pathname === "/1/download")
        return new Response(null, {
          status: 301,
          headers: { location: `magnet:?xt=urn:btih:${hash}` },
        });
      assert.equal(url.origin, "https://api.torbox.app");
      if (url.pathname.endsWith("/mylist"))
        return Response.json({ success: true, data: [] });
      assert(url.pathname.endsWith("/checkcached"));
      return Response.json({
        success: true,
        data: options.miss
          ? {}
          : {
              [hash]: {
                hash,
                name: title,
                files: [{ name: `${title}.epub`, size: 100 }],
              },
            },
      });
    },
    logger: { log() {}, warn() {} },
    buildSearchText: (query) => (query.author ? "HOST SEARCH TEXT" : "Dune"),
    async saveCredential() {
      throw Error("Unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  return { host, calls };
}

test("keyword search uses the host helper and normalized title for file selection", async () => {
  const f = fixture();
  const releases = await plugin.search(
    { ...q, title: "Dune (Deluxe Edition)" },
    cfg,
    f.host,
    AbortSignal.timeout(1000),
  );
  assert.equal(f.calls[0].searchParams.get("q"), "HOST SEARCH TEXT");
  assert.equal(releases.length, 1);
  assert.equal(JSON.parse(releases[0].guid).title, "Dune");
});

test("source release titles are retained without inventing an exact work-title match", async () => {
  const f = fixture({ title: "Dune Messiah" });
  const [release] = await plugin.search(
    q,
    cfg,
    f.host,
    AbortSignal.timeout(1000),
  );
  assert(release.title.startsWith("Dune Messiah"));
  assert.equal(release.bookTitle, undefined);
});

test("author and language metadata reach BookOrbit unchanged for scoring and filtering", async () => {
  for (const source of [
    { author: "Justin Mares", language: "eng" },
    { author: "Another Writer", language: "fr" },
  ]) {
    const f = fixture(source);
    const [release] = await plugin.search(
      { ...q, author: "Gabriel Weinberg & Justin Mares" },
      cfg,
      f.host,
      AbortSignal.timeout(1000),
    );
    assert(release);
    assert.equal(release.author, source.author);
    assert.equal(release.language, source.language);
  }
});

test("partial author and language aliases do not prevent bounded metadata resolution", async () => {
  const f = fixture({
    author: "Justin Mares",
    language: "eng",
    metadata: true,
  });
  const [release] = await plugin.search(
    { ...q, author: "Gabriel Weinberg & Justin Mares" },
    cfg,
    f.host,
    AbortSignal.timeout(1000),
  );
  assert(release);
  assert.equal(release.author, "Justin Mares");
  assert.equal(release.language, "eng");
  assert.equal(
    f.calls.filter((url) => url.pathname === "/1/download").length,
    1,
  );
});

test("preparation labels retain the source release name and do not invent a work title", async () => {
  const f = fixture({ title: "Dune Messiah", miss: true });
  const [release] = await plugin.search(
    q,
    { ...cfg, settings: { ...cfg.settings, prepareUncached: true } },
    f.host,
    AbortSignal.timeout(1000),
  );
  assert(release.title.startsWith("Dune Messiah · Prepare in"));
  assert.equal(release.bookTitle, undefined);
  assert(f.calls.every((url) => !url.pathname.endsWith("/createtorrent")));
});
