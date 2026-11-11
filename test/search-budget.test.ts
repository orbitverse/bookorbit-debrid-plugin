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
function fixture(
  stalled: boolean | "mixed" | "slow" | "last two answer" = false,
  onFeedRequest = () => {},
) {
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
        onFeedRequest();
        if (stalled === "last two answer") {
          if (url.pathname !== "/5/api" && url.pathname !== "/6/api")
            return new Promise(() => {});
          return feed(
            `<item><title>The Little Prince Audiobook</title><torznab:attr name="infohash" value="${hash}"/></item>`,
          );
        }
        if (stalled === "slow") {
          if (url.pathname !== "/1/api") return feed();
          await pause(13000);
          return feed(
            `<item><title>The Little Prince Audiobook</title><torznab:attr name="infohash" value="${hash}"/></item>`,
          );
        }
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
      const elapsed = performance.now() - start;
      // Nothing was worth checking at twelve seconds, so the feeds get the longer deadline.
      assert(elapsed >= 15000 && elapsed < 18000, `Search took ${elapsed}ms`);
      assert(!f.stages.includes("cache"));
      assert(
        f.warnings.some((message) =>
          message.includes(
            mode === true ? "/1/api, /2/api, /3/api" : "/1/api, /3/api",
          ),
        ),
      );
    }),
  );
});

test("a feed that answers after twelve seconds is kept when no other feed had matches", async () => {
  const f = fixture("slow"),
    start = performance.now();
  const releases = await plugin.search(
    query,
    config,
    f.host,
    AbortSignal.timeout(20000),
  );
  const elapsed = performance.now() - start;
  assert.equal(releases.length, 1);
  assert(f.stages.includes("cache"));
  assert(elapsed >= 13000 && elapsed < 18000, `Search took ${elapsed}ms`);
  assert(!f.warnings.some((message) => /timed out/i.test(message)));
});

test("six configured feeds are all requested when the first four never answer", async () => {
  const f = fixture("last two answer");
  const paths = [1, 2, 3, 4, 5, 6].map((id) => `/${id}/api`);
  const outcome = await plugin
    .search(
      query,
      { ...config, settings: { indexerPaths: paths.join(",") } },
      f.host,
      AbortSignal.timeout(20000),
    )
    .catch((error: unknown) => error);
  assert.equal(f.stages.filter((stage) => stage === "feed").length, 6);
  assert(Array.isArray(outcome), `Search failed: ${outcome}`);
  assert.equal(outcome.length, 1);
  assert(
    f.warnings.some((message) =>
      message.includes("waiting for /1/api, /2/api, /3/api, /4/api."),
    ),
  );
});

test("caller cancellation stops feed collection without querying cache or returning partial releases", async () => {
  const caller = new AbortController();
  const f = fixture(true, () => caller.abort());
  await assert.rejects(
    plugin.search(query, config, f.host, caller.signal),
    /cancelled/,
  );
  assert(f.stages.includes("feed"));
  assert(!f.stages.includes("cache"));
});

test("slow indexer discovery is reported as slow discovery, not as feeds that never answered", async () => {
  const f = fixture(true);
  const fetch = f.host.fetch;
  // The indexer list's headers arrive at once; its body arrives after the discovery limit.
  f.host.fetch = async (input, init) =>
    new URL(input).pathname === "/api/v1/indexer"
      ? new Response(
          new ReadableStream({
            async start(controller) {
              await pause(13000);
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify([
                    {
                      id: 1,
                      enable: true,
                      supportsSearch: true,
                      protocol: "torrent",
                      privacy: "public",
                      capabilities: { categories: [{ id: 3030 }] },
                    },
                  ]),
                ),
              );
              controller.close();
            },
          }),
        )
      : fetch(input, init);
  const start = performance.now();
  await assert.rejects(
    plugin.search(query, config, f.host, AbortSignal.timeout(20000)),
    (error) => {
      assert(error instanceof Error && "kind" in error);
      assert.equal(error.kind, "timeout");
      assert.match(error.message, /^Prowlarr: indexer discovery timed out/);
      assert(!error.message.includes("/1/api"), error.message);
      return true;
    },
  );
  const elapsed = performance.now() - start;
  // Discovery ends at twelve seconds, which leaves feeds at least four of the stage's sixteen.
  assert(elapsed >= 11900 && elapsed < 13000, `Search took ${elapsed}ms`);
  assert(!f.stages.includes("feed"));
  assert(!f.warnings.some((message) => message.includes("/1/api")));
});

test("indexer discovery whose headers never arrive gets the same discovery timeout", async () => {
  const f = fixture(true);
  const fetch = f.host.fetch;
  f.host.fetch = (input, init) =>
    new URL(input).pathname === "/api/v1/indexer"
      ? new Promise<Response>(() => {})
      : fetch(input, init);
  const start = performance.now();
  await assert.rejects(
    plugin.search(query, config, f.host, AbortSignal.timeout(20000)),
    (error) => {
      assert(error instanceof Error && "kind" in error);
      assert.equal(error.kind, "timeout");
      assert.match(error.message, /^Prowlarr: indexer discovery timed out/);
      return true;
    },
  );
  const elapsed = performance.now() - start;
  assert(elapsed >= 11900 && elapsed < 13000, `Search took ${elapsed}ms`);
  assert(!f.stages.includes("feed"));
});

test("feeds that answer before twelve seconds are all kept, even after another feed matched", async () => {
  const other = "b".repeat(40);
  const answers: Record<string, [number, string]> = {
    "/1/api": [500, hash],
    "/2/api": [3000, other],
  };
  const host: PluginHost = {
    ...fixture().host,
    async fetch(input, init) {
      const url = new URL(input);
      const answer = answers[url.pathname];
      if (answer) {
        await pause(answer[0]);
        return feed(
          `<item><title>The Little Prince Audiobook</title><torznab:attr name="infohash" value="${answer[1]}"/></item>`,
        );
      }
      assert(url.pathname.endsWith("/checkcached"));
      return Response.json({
        success: true,
        data: Object.fromEntries(
          (JSON.parse(init!.body!).hashes as string[]).map((h) => [
            h,
            {
              hash: h,
              name: "The Little Prince",
              files: [{ name: "The Little Prince.m4b", size: 123 }],
            },
          ]),
        ),
      });
    },
  };
  const start = performance.now();
  const releases = await plugin.search(
    query,
    { ...config, settings: { indexerPaths: "/1/api,/2/api" } },
    host,
    AbortSignal.timeout(20000),
  );
  const elapsed = performance.now() - start;
  assert.deepEqual(
    releases.map((release) => JSON.parse(release.guid).hash),
    [hash, other],
  );
  // Answered once both feeds settled, without waiting for the twelve-second mark.
  assert(elapsed >= 3000 && elapsed < 6000, `Search took ${elapsed}ms`);
});

test("time spent on indexer discovery comes out of the time feeds are given", async () => {
  const f = fixture(true);
  const fetch = f.host.fetch;
  f.host.fetch = async (input, init) => {
    if (new URL(input).pathname === "/api/v1/indexer") await pause(5000);
    return fetch(input, init);
  };
  const start = performance.now();
  await assert.rejects(
    plugin.search(query, config, f.host, AbortSignal.timeout(20000)),
    (error) => {
      assert(error instanceof Error && "kind" in error);
      assert.equal(error.kind, "timeout");
      assert.match(error.message, /^Indexer search timed out waiting for/);
      return true;
    },
  );
  const elapsed = performance.now() - start;
  // Sixteen seconds from the start of the search, not sixteen after discovery finished.
  assert(elapsed >= 15500 && elapsed < 17000, `Search took ${elapsed}ms`);
});
