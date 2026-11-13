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
  baseUrl: "http://indexer.example",
  allowPrivateAddress: false,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/1/api" },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER",
    debrid: { provider: "torbox", key: "SYNTHETIC_PROVIDER" },
  }),
};

test("a download that times out on a slow provider does not blame indexers", async () => {
  let delay = 0,
    indexerCalls = 0;
  const host: PluginHost = {
    async fetch(input) {
      const url = new URL(input);
      if (url.pathname === "/1/api") {
        indexerCalls++;
        return new Response(
          `<rss><channel><title>Books</title><item><title>Book</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`,
        );
      }
      assert.equal(url.origin, "https://api.torbox.app");
      // Each provider answer is slow but within its own request limit.
      await new Promise((resolve) => setTimeout(resolve, delay));
      return Response.json({
        success: true,
        data: url.pathname.endsWith("/checkcached")
          ? {
              [hash]: {
                hash,
                name: "Book",
                files: [{ name: "Book.epub", size: 100 }],
              },
            }
          : [],
      });
    },
    logger: { log() {}, warn() {} },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  const [release] = await plugin.search(
    query,
    config,
    host,
    AbortSignal.timeout(1000),
  );
  assert(release);
  delay = 10_000;
  indexerCalls = 0;
  await assert.rejects(
    plugin.resolveFile(release, config, host, new AbortController().signal),
    (error: Error & { kind?: string }) => {
      assert.equal(error.kind, "timeout");
      assert.match(error.message, /^Request timed out\./);
      assert.doesNotMatch(error.message, /indexer/i);
      return true;
    },
  );
  assert.equal(indexerCalls, 0);
});
