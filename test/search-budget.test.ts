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
  title: "The Little Prince",
  author: null,
  isbn13: null,
  isbn13s: [],
  mediaKind: "audiobook",
  language: "en",
  limit: 20,
};
const config: PluginIndexerConfig = {
  id: 1,
  name: "Books",
  baseUrl: "http://indexer.example:9696",
  allowPrivateAddress: true,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: {},
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER",
    debrid: { provider: "torbox", key: "SYNTHETIC_PROVIDER" },
  }),
};
const feed = (items = "") =>
  new Response(`<rss><channel><title>Books</title>${items}</channel></rss>`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(stalled: boolean | "mixed" = false) {
  const stages: string[] = [],
    warnings: string[] = [];
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(init?.redirect, "manual");
      if (url.pathname === "/api/v1/indexer") {
        stages.push("discovery");
        await pause(200);
        return Response.json(
          [1, 2, 3].map((id) => ({
            id,
            enable: true,
            supportsSearch: true,
            protocol: "torrent",
            privacy: "public",
            capabilities: { categories: [{ id: 3030 }] },
          })),
        );
      }
      if (url.pathname.endsWith("/api")) {
        stages.push("feed");
        if (
          stalled === true ||
          (stalled === "mixed" && url.pathname !== "/2/api") ||
          url.pathname === "/3/api"
        )
          return new Promise(() => {});
        if (url.pathname === "/2/api") return feed();
        return feed(
          '<item><title>The Little Prince Audiobook</title><enclosure type="application/x-bittorrent" url="/1/download?link=opaque"/></item>',
        );
      }
      if (url.pathname === "/1/download") {
        stages.push("metadata");
        await pause(6500);
        return new Response(null, {
          status: 301,
          headers: { location: `magnet:?xt=urn:btih:${hash}` },
        });
      }
      assert.equal(url.origin, "https://api.torbox.app");
      assert(url.pathname.endsWith("/checkcached"));
      assert.deepEqual(JSON.parse(init!.body!).hashes, [hash]);
      stages.push("cache");
      await pause(3000);
      return Response.json({
        success: true,
        data: {
          [hash]: {
            hash,
            name: "The Little Prince",
            files: [{ name: "The Little Prince.m4b", size: 123 }],
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
  return { host, stages, warnings };
}

test("three automatically discovered feeds preserve a late metadata audiobook and leave time for cache access", async () => {
  const f = fixture(),
    start = performance.now();
  const releases = await plugin.search(
    query,
    config,
    f.host,
    AbortSignal.timeout(20000),
  );
  assert.equal(releases.length, 1);
  assert.equal(releases[0].format, "m4b");
  assert.equal(f.stages.filter((stage) => stage === "feed").length, 3);
  assert(f.stages.includes("metadata") && f.stages.includes("cache"));
  assert(performance.now() - start < 18000);
  assert(f.warnings.some((message) => /timed out/i.test(message)));
});

test("an unfinished three-feed collection returns a timeout instead of a false empty search", async () => {
  await Promise.all(
    [true, "mixed" as const].map(async (mode) => {
      const f = fixture(mode),
        start = performance.now();
      await assert.rejects(
        plugin.search(query, config, f.host, AbortSignal.timeout(20000)),
        (error) => {
          assert(error instanceof Error && "kind" in error);
          assert.equal(error.kind, "timeout");
          return true;
        },
      );
      assert(performance.now() - start < 14000);
      assert(!f.stages.includes("cache"));
    }),
  );
});

test("caller cancellation stops feed collection without querying cache or returning partial releases", async () => {
  const f = fixture(true);
  await assert.rejects(
    plugin.search(query, config, f.host, AbortSignal.timeout(30)),
    /cancelled/,
  );
  assert(!f.stages.includes("cache"));
});
