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
  settings: { indexerPaths: "/3/api,/3/api/" },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER",
    debrid: { provider: "torbox", key: "SYNTHETIC_PROVIDER" },
  }),
};
function fixture(mode: "success" | "failure" | "stream" = "success") {
  let metadataCalls = 0,
    cacheCalls = 0,
    cancelled = 0;
  const warnings: string[] = [];
  const host: PluginHost = {
    async fetch(input) {
      const url = new URL(input);
      if (/\/api\/?$/.test(url.pathname)) {
        const download = url.pathname.endsWith("/")
          ? `${url.origin}/3/download?link=same&apikey=REPLACED`
          : "/3/download?link=same";
        return new Response(
          `<rss><channel><title>Books</title><item><title>Book</title><enclosure url="${download.replaceAll("&", "&amp;")}"/></item></channel></rss>`,
        );
      }
      if (url.pathname === "/3/download") {
        metadataCalls++;
        assert.equal(url.searchParams.get("apikey"), "SYNTHETIC_INDEXER");
        if (mode === "stream")
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
          );
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (mode === "failure") return new Response("blocked", { status: 403 });
        return new Response(null, {
          status: 301,
          headers: { location: `magnet:?xt=urn:btih:${hash}` },
        });
      }
      assert.equal(url.origin, "https://api.torbox.app");
      assert(url.pathname.endsWith("/checkcached"));
      cacheCalls++;
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
    logger: { log() {}, warn: (message) => warnings.push(message) },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  return {
    host,
    warnings,
    counts: () => ({ metadataCalls, cacheCalls, cancelled }),
  };
}

test("equivalent trusted links share metadata within a search, with no reuse across searches", async () => {
  const f = fixture();
  for (let i = 1; i <= 2; i++) {
    const results = await plugin.search(
      query,
      config,
      f.host,
      AbortSignal.timeout(1000),
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].format, "epub");
    assert.equal(f.counts().metadataCalls, i);
    assert.equal(f.counts().cacheCalls, i);
  }
});

test("metadata failures are shared within the search and retried on a new search", async () => {
  const f = fixture("failure");
  for (let i = 1; i <= 2; i++) {
    assert.deepEqual(
      await plugin.search(query, config, f.host, AbortSignal.timeout(1000)),
      [],
    );
    assert.equal(f.counts().metadataCalls, i);
  }
  assert.equal(f.counts().cacheCalls, 0);
  assert(!f.warnings.join(" ").includes("SYNTHETIC"));
});

test("sharing a URL does not bypass another feed's download-path validation", async () => {
  const f = fixture();
  const results = await plugin.search(
    query,
    { ...config, settings: { indexerPaths: "/3/api,/4/api" } },
    f.host,
    AbortSignal.timeout(1000),
  );
  assert.equal(results.length, 1);
  assert.equal(f.counts().metadataCalls, 1);
  assert(
    f.warnings.some((message) => message.includes("could not be resolved")),
  );
});

test("caller cancellation releases the shared metadata stream without calling the provider", async () => {
  const f = fixture("stream");
  await assert.rejects(
    plugin.search(query, config, f.host, AbortSignal.timeout(100)),
    /cancelled/,
  );
  assert.deepEqual(f.counts(), {
    metadataCalls: 1,
    cacheCalls: 0,
    cancelled: 1,
  });
});
