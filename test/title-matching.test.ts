import assert from "node:assert/strict";
import test from "node:test";
import { matches } from "../src/books.js";
import plugin from "../src/index.js";
import type {
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

test("titles that differ only by an apostrophe match in both directions", () => {
  for (const [query, title] of [
    ["Ender's Game", "Enders Game - Orson Scott Card [EPUB]"],
    ["Enders Game", "Ender's Game - Orson Scott Card [EPUB]"],
    ["Ender’s Game", "Enders Game - Orson Scott Card [EPUB]"],
    ["Enders Game", "Ender’s Game - Orson Scott Card [EPUB]"],
    ["Ender's Game", "Ender’s Game - Orson Scott Card [EPUB]"],
    ["Ender's Game", "Ender_s_Game.epub"],
  ])
    assert(matches(query, title), `${query} should match ${title}`);
});

test('titles that differ only by "&" versus "and" match in both directions', () => {
  for (const [query, title] of [
    ["Pride and Prejudice", "Pride & Prejudice - Jane Austen epub"],
    ["Pride & Prejudice", "Pride and Prejudice - Jane Austen epub"],
    ["Pride & Prejudice", "Pride & Prejudice - Jane Austen epub"],
    ["Pride and Prejudice", "Pride&Prejudice.epub"],
  ])
    assert(matches(query, title), `${query} should match ${title}`);
});

test("a title missing a real query word is still rejected", () => {
  for (const [query, title] of [
    ["Ender's Game", "Enders Shadow - Orson Scott Card [EPUB]"],
    ["Ender's Game", "Ender's Shadow - Orson Scott Card [EPUB]"],
    ["Enders Game", "Ender's Shadow - Orson Scott Card [EPUB]"],
    ["Pride and Prejudice", "Pride & Zombies epub"],
    ["Pride and Prejudice", "Pride Prejudice epub"],
    ["Pride & Prejudice", "Pride and Zombies epub"],
    ["Sapiens: A Brief History of Humankind", "Sapiens - Yuval Noah Harari"],
    ["'", "Enders Game"],
    ["&", "Pride & Prejudice"],
  ])
    assert(!matches(query, title), `${query} should not match ${title}`);
});

test("a search with an apostrophe finds a cached release titled without one", async () => {
  const hash = "a".repeat(40);
  const title = "Enders Game - Orson Scott Card [EPUB]";
  const query: PluginReleaseQuery = {
    title: "Ender's Game",
    author: "Orson Scott Card",
    isbn13: null,
    isbn13s: [],
    mediaKind: "ebook",
    language: "en",
    limit: 20,
  };
  const config: PluginIndexerConfig = {
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
  const host: PluginHost = {
    async fetch(input) {
      const url = new URL(input);
      if (url.pathname === "/1/api")
        return new Response(
          `<rss><channel><title>Books</title><item><title>${title}</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`,
        );
      assert.equal(url.origin, "https://api.torbox.app");
      assert(url.pathname.endsWith("/checkcached"));
      return Response.json({
        success: true,
        data: {
          [hash]: {
            hash,
            name: title,
            files: [{ name: "Enders Game.epub", size: 100 }],
          },
        },
      });
    },
    logger: { log() {}, warn() {} },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("Unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  const releases = await plugin.search(
    query,
    config,
    host,
    AbortSignal.timeout(1000),
  );
  assert.equal(releases.length, 1);
  assert(releases[0].title.startsWith("Enders Game"));
  assert.equal(releases[0].format, "epub");
});
