import assert from "node:assert/strict";
import test, { describe } from "node:test";
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

// Feed collection ends when every feed has finished, from twelve seconds once a finished feed has
// a match, and at sixteen seconds. Whatever is known at that moment is used. Each case below is
// one search against feeds and torrent links that answer at set times; the cases run side by
// side because every one of them takes real seconds.
const numbered = (n: number) => n.toString(16).padStart(40, "0");
const hashed = (n: number, title = "The Little Prince Audiobook") =>
  `<item><title>${title}</title><torznab:attr name="infohash" value="${numbered(n)}"/></item>`;
/** A result whose hash is behind a torrent link that answers after `delay`, or never. */
const linked = (feedPath: string, n: number, delay: number | "never") =>
  `<item><title>The Little Prince Audiobook</title><enclosure type="application/x-bittorrent" url="${feedPath}/download?link=${n}-${delay}"/></item>`;
const never = () => new Promise<never>(() => {});
/** In place of a feed's items: the feed answers HTTP 500. */
const unavailable = "HTTP 500";
const stoppedWhile = (checking: string) =>
  `Indexer search stopped while ${checking} still checking torrent links.`;
const waitingFor = (paths: string) =>
  `Indexer search timed out waiting for ${paths}. Retry shortly; the first search after a restart can be slow.`;
const stillChecking = (paths: string) =>
  `Indexer search stopped while ${paths} was still checking torrent links; matches already identified remain available.`;
type Feeds = Record<string, readonly [number | null, string?]>;
/**
 * Searches feeds that answer `[after milliseconds, with these items]`, or never when the time is
 * `null`. `link` may replace how long torrent link `n` takes to answer.
 */
async function timeline(
  feeds: Feeds,
  link?: (n: number) => Promise<unknown>,
  limit = query.limit,
  cacheTakes = 0,
) {
  const warnings: string[] = [],
    asked: number[] = [];
  let cacheAt: number | undefined;
  const start = performance.now();
  const host: PluginHost = {
    ...fixture().host,
    logger: { log() {}, warn: (message) => warnings.push(message) },
    async fetch(input, init) {
      const url = new URL(input);
      const answer = feeds[url.pathname];
      if (answer) {
        if (answer[0] === null) return never();
        await pause(answer[0]);
        return answer[1] === unavailable
          ? new Response(null, { status: 500 })
          : feed(answer[1]);
      }
      if (url.pathname.endsWith("/download")) {
        const [n, delay] = url.searchParams.get("link")!.split("-");
        if (delay === "never") return never();
        await (link ? link(Number(n)) : pause(Number(delay)));
        return new Response(null, {
          status: 301,
          headers: { location: `magnet:?xt=urn:btih:${numbered(Number(n))}` },
        });
      }
      assert(url.pathname.endsWith("/checkcached"));
      cacheAt = performance.now() - start;
      const hashes = JSON.parse(init!.body!).hashes as string[];
      asked.push(...hashes.map((h) => parseInt(h, 16)));
      await pause(cacheTakes);
      return Response.json({
        success: true,
        data: Object.fromEntries(
          hashes.map((h) => [
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
  const outcome = await plugin
    .search(
      { ...query, limit },
      { ...config, settings: { indexerPaths: Object.keys(feeds).join(",") } },
      host,
      AbortSignal.timeout(20000),
    )
    .catch((error: unknown) => error);
  const elapsed = performance.now() - start;
  return {
    // The numbers of the releases' hashes in the order returned, or the search's failure.
    releases: Array.isArray(outcome)
      ? outcome.map((release) => parseInt(JSON.parse(release.guid).hash, 16))
      : (outcome as Error & { kind: string }),
    asked,
    warnings,
    elapsed,
    // When collection ended: the cache was asked, or the search failed without asking it.
    endedAt: cacheAt ?? elapsed,
  };
}
const first = (count: number) => Array.from({ length: count }, (_, n) => n);
const within = (elapsed: number, from: number, to: number) =>
  assert(elapsed >= from && elapsed < to, `Took ${elapsed}ms`);

describe("when feed collection ends", { concurrency: true }, () => {
  test("every hashed match of a feed that answers after twelve seconds is used", async () => {
    await Promise.all(
      [1, 5, 30].map(async (count) => {
        const run = await timeline(
          {
            "/1/api": [
              12500,
              first(count)
                .map((n) => hashed(n))
                .join(""),
            ],
          },
          undefined,
          100,
        );
        assert.deepEqual(run.asked, first(count));
        assert.deepEqual(run.releases, first(count));
        assert.deepEqual(run.warnings, []);
        within(run.elapsed, 12400, 14000);
      }),
    );
  });

  test("four torrent links give four releases whenever their feed answers", async () => {
    await Promise.all(
      [1000, 11700, 12500].map(async (at) => {
        const run = await timeline({
          "/1/api": [
            at,
            first(4)
              .map((n) => linked("/1", n, 200 + 25 * n))
              .join(""),
          ],
        });
        assert.deepEqual(run.releases, first(4), `at ${at}ms`);
        assert.deepEqual(run.warnings, []);
        // Two links are looked up at a time, so four take two rounds.
        within(run.elapsed, at + 400, at + 1500);
      }),
    );
  });

  test("two torrent links that answer in the same instant after twelve seconds are both used", async () => {
    let together: Promise<unknown> | undefined;
    const run = await timeline(
      { "/1/api": [12200, linked("/1", 0, 300) + linked("/1", 1, 300)] },
      () => (together ??= pause(300)),
    );
    assert.deepEqual([...(run.releases as number[])].sort(), [0, 1]);
    assert.deepEqual(run.warnings, []);
  });

  test("hashed matches are used at sixteen seconds when a torrent link beside them never answers", async () => {
    await Promise.all(
      // Either way the feed has not finished by sixteen seconds: its link has ten from its answer.
      [9500, 12500].map(async (at) => {
        const run = await timeline({
          "/1/api": [
            at,
            first(3)
              .map((n) => hashed(n))
              .join("") + linked("/1", 3, "never"),
          ],
        });
        assert.deepEqual(run.releases, first(3), `at ${at}ms`);
        assert.deepEqual(run.warnings, [stillChecking("/1/api")]);
        within(run.endedAt, 15950, 16050);
      }),
    );
  });

  test("a feed still checking its only torrent link at sixteen seconds is a timeout that says so", async () => {
    const run = await timeline({ "/1/api": [7000, linked("/1", 0, "never")] });
    assert(run.releases instanceof Error);
    assert.equal(run.releases.kind, "timeout");
    assert.equal(
      run.releases.message,
      "Indexer search timed out while /1/api was still checking torrent links. Retry shortly; the first search after a restart can be slow.",
    );
    assert.deepEqual(run.asked, []);
    assert.deepEqual(run.warnings, []);
    within(run.elapsed, 15950, 17000);
  });

  test("at twelve seconds a finished match is joined by what a feed still checking links already knows", async () => {
    const run = await timeline({
      "/1/api": [1000, hashed(0)],
      "/2/api": [3500, hashed(1) + linked("/2", 2, "never")],
      "/3/api": [null],
    });
    assert.deepEqual(run.releases, [0, 1]);
    assert.deepEqual(run.warnings, [
      waitingFor("/3/api"),
      stillChecking("/2/api"),
    ]);
    within(run.endedAt, 11950, 12050);
  });

  test("a match first known after fourteen seconds is not held back by another feed's hanging link", async () => {
    const run = await timeline({
      "/1/api": [6000, linked("/1", 0, "never")],
      "/2/api": [14010, hashed(1) + hashed(2)],
    });
    assert.deepEqual(run.releases, [1, 2]);
    assert.deepEqual(run.warnings, [stillChecking("/1/api")]);
    within(run.endedAt, 13960, 14060);
  });

  test("a match with nothing being looked up is answered at twelve seconds without the silent feed", async () => {
    const run = await timeline({
      "/1/api": [1000, hashed(0)],
      "/2/api": [null],
    });
    assert.deepEqual(run.releases, [0]);
    assert.deepEqual(run.warnings, [waitingFor("/2/api")]);
    within(run.elapsed, 11900, 13000);
  });

  // From here on: the search ends in an error although some feed had answered and was still
  // checking links. The cap on the whole search is eighteen seconds.
  test("a feed's failure is the error when the cache is too slow for an unfinished feed's match", async () => {
    const feeds: Feeds = {
      "/1/api": [10000, unavailable],
      "/2/api": [15000, hashed(0) + linked("/2", 1, 5000)],
    };
    const failure = "/1/api: Torznab: HTTP 500. Retry later.";
    const [slow, quick] = await Promise.all([
      timeline(feeds, undefined, query.limit, 2500),
      timeline(feeds, undefined, query.limit, 300),
    ]);
    assert(slow.releases instanceof Error);
    assert.equal(slow.releases.message, failure);
    assert.deepEqual(slow.asked, [0]);
    assert.deepEqual(slow.warnings, [stoppedWhile("/2/api was")]);
    within(slow.endedAt, 15950, 16050);
    within(slow.elapsed, 17000, 18000);
    assert.deepEqual(quick.releases, [0]);
    assert.deepEqual(quick.warnings, [failure, stillChecking("/2/api")]);
  });

  test("the collection timeout is the error when the cache is too slow for an unfinished feed's match", async () => {
    const run = await timeline(
      {
        "/1/api": [null],
        "/2/api": [15000, hashed(0) + linked("/2", 1, 5000)],
      },
      undefined,
      query.limit,
      2500,
    );
    assert(run.releases instanceof Error);
    assert.equal(run.releases.kind, "timeout");
    assert.equal(run.releases.message, waitingFor("/1/api"));
    assert.deepEqual(run.warnings, [
      waitingFor("/1/api"),
      stoppedWhile("/2/api was"),
    ]);
    within(run.elapsed, 17000, 18000);
  });

  test("a timeout naming a silent feed leaves the feeds still checking links to a warning", async () => {
    const run = await timeline({
      "/1/api": [null],
      "/2/api": [7000, linked("/2", 0, "never")],
      "/3/api": [8000, linked("/3", 1, "never")],
    });
    assert(run.releases instanceof Error);
    assert.equal(run.releases.message, waitingFor("/1/api"));
    assert.deepEqual(run.warnings, [
      waitingFor("/1/api"),
      stoppedWhile("/2/api, /3/api were"),
    ]);
    within(run.elapsed, 15950, 17000);
  });

  test("a feed's failure is reported once, beside the feed still checking links", async () => {
    const run = await timeline({
      "/1/api": [500, "<error/>"],
      "/2/api": [7000, linked("/2", 0, "never")],
    });
    assert(run.releases instanceof Error);
    assert.equal(
      run.releases.message,
      "/1/api: Torznab rejected the search. Check the API key and indexer settings.",
    );
    assert.deepEqual(run.warnings, [stoppedWhile("/2/api was")]);
    within(run.elapsed, 15950, 17000);
  });

  // `before` is what the search did before it used what unfinished feeds knew, recorded by running
  // each scenario against that version: when collection ended, and the releases or the kind of
  // failure. `gains` are the releases unfinished feeds add now.
  const rejected = "<error/>";
  const scenarios: Record<
    string,
    {
      feeds: Feeds;
      before: readonly [number, readonly number[] | "timeout" | "error"];
      gains?: readonly number[];
    }
  > = {
    "one fast feed": {
      feeds: { "/1/api": [500, hashed(0)] },
      before: [500, [0]],
    },
    "two fast feeds and a silent one": {
      feeds: {
        "/1/api": [500, hashed(0)],
        "/2/api": [3000, hashed(1)],
        "/3/api": [null],
      },
      before: [12000, [0, 1]],
    },
    "a match early and a feed that answers after thirteen seconds": {
      feeds: { "/1/api": [1000, hashed(0)], "/2/api": [13000, hashed(1)] },
      before: [12000, [0]],
    },
    "a single feed answering after twelve seconds": {
      feeds: { "/1/api": [12500, hashed(0) + hashed(1) + hashed(2)] },
      before: [12500, [0, 1, 2]],
    },
    "an empty feed, a late feed and a silent feed": {
      feeds: {
        "/1/api": [500, ""],
        "/2/api": [13000, hashed(0) + hashed(1)],
        "/3/api": [null],
      },
      before: [13000, [0, 1]],
    },
    "four quick links": {
      feeds: {
        "/1/api": [
          1000,
          first(4)
            .map((n) => linked("/1", n, 200 + 25 * n))
            .join(""),
        ],
      },
      before: [1500, [0, 1, 2, 3]],
    },
    "a hanging link that uses up its budget before twelve seconds": {
      feeds: {
        "/1/api": [1000, hashed(0) + linked("/1", 1, "never")],
        "/2/api": [null],
      },
      before: [12000, [0]],
    },
    "hashed matches beside a hanging link, alone": {
      feeds: {
        "/1/api": [
          9500,
          hashed(0) + hashed(1) + hashed(2) + linked("/1", 3, "never"),
        ],
      },
      before: [16000, "timeout"],
      gains: [0, 1, 2],
    },
    "a finished match, a feed mid-lookup and a silent feed": {
      feeds: {
        "/1/api": [1000, hashed(0)],
        "/2/api": [3500, hashed(1) + linked("/2", 2, "never")],
        "/3/api": [null],
      },
      before: [12000, [0]],
      gains: [1],
    },
    "a rejected feed and a fast feed": {
      feeds: { "/1/api": [500, rejected], "/2/api": [2000, hashed(0)] },
      before: [2000, [0]],
    },
    "a rejected feed and a silent feed": {
      feeds: { "/1/api": [500, rejected], "/2/api": [null] },
      before: [16000, "error"],
    },
    "a late match beside another feed's hanging link": {
      feeds: {
        "/1/api": [6000, linked("/1", 0, "never")],
        "/2/api": [14010, hashed(1) + hashed(2)],
      },
      before: [14010, [1, 2]],
    },
    "one link resolved and one hanging at twelve seconds": {
      feeds: {
        "/1/api": [11000, linked("/1", 1, 300) + linked("/1", 2, "never")],
        "/2/api": [1000, hashed(0)],
        "/3/api": [null],
      },
      before: [12000, [0]],
      gains: [1],
    },
    "only silent feeds": {
      feeds: { "/1/api": [null], "/2/api": [null] },
      before: [16000, "timeout"],
    },
    "nothing early and a late feed with a hanging link": {
      feeds: {
        "/1/api": [1000, ""],
        "/2/api": [15000, hashed(0) + linked("/2", 1, "never")],
      },
      before: [16000, "timeout"],
      gains: [0],
    },
    "a hash shared by a finished and an unfinished feed": {
      feeds: {
        "/1/api": [1000, hashed(0) + hashed(1)],
        "/2/api": [4000, hashed(1) + hashed(2) + linked("/2", 3, "never")],
        "/3/api": [null],
      },
      before: [12000, [0, 1]],
      gains: [2],
    },
    "finished feeds with nothing matching": {
      feeds: {
        "/1/api": [500, ""],
        "/2/api": [800, hashed(0, "Another Book")],
      },
      before: [800, []],
    },
    "a rejected feed beside a late feed with a hanging link": {
      feeds: {
        "/1/api": [500, rejected],
        "/2/api": [13000, hashed(0) + linked("/2", 1, "never")],
      },
      before: [16000, "error"],
      gains: [0],
    },
  };
  test("collection ends when it did before and returns at least what it did, in the same order", async () => {
    await Promise.all(
      Object.entries(scenarios).map(async ([name, scenario]) => {
        const [endedAt, releases] = scenario.before;
        const run = await timeline(scenario.feeds);
        assert(
          Math.abs(run.endedAt - endedAt) < 50,
          `${name}: ended at ${run.endedAt}ms, not ${endedAt}ms`,
        );
        const kept = typeof releases === "string" ? [] : releases;
        if (kept.length || scenario.gains || typeof releases !== "string")
          assert.deepEqual(
            run.releases,
            [...kept, ...(scenario.gains ?? [])],
            name,
          );
        else {
          assert(run.releases instanceof Error, name);
          assert.equal(run.releases.kind, releases, name);
        }
      }),
    );
  });
});
