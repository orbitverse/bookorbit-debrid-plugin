import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import type {
  PluginHost,
  PluginIndexerConfig,
} from "../vendor/bookorbit-plugin-api.js";

const config = (provider: string, settings: Record<string, unknown>) =>
  ({
    id: 1,
    name: "Books",
    baseUrl: "http://indexer.example",
    credential: JSON.stringify({
      indexerKey: "SYNTHETIC_INDEXER",
      debrid: { provider, key: "SYNTHETIC_PROVIDER" },
    }),
    allowPrivateAddress: false,
    categories: { ebook: [7020], audiobook: [3030] },
    settings,
  }) as PluginIndexerConfig;
const host: PluginHost = {
  async fetch(input) {
    const url = new URL(input);
    if (url.pathname === "/api/v1/indexer")
      return Response.json([
        {
          id: 1,
          enable: true,
          supportsSearch: true,
          protocol: "torrent",
          privacy: "public",
          capabilities: { categories: [{ id: 7020 }] },
        },
      ]);
    if (url.pathname === "/1/api")
      return new Response("<rss><channel><title>Books</title></channel></rss>");
    if (url.hostname === "api.real-debrid.com")
      return Response.json({ id: 1, type: "premium", premium: 1000 });
    if (url.hostname === "debrid-link.com")
      return Response.json({
        success: true,
        value: { accountType: 1, premiumLeft: 1000 },
      });
    return Response.json({ success: true, data: {} });
  },
  logger: { log() {}, warn() {} },
  buildSearchText: (q) => q.title,
  async saveCredential() {
    throw Error("Unexpected credential write");
  },
  fail: (kind, message) => Object.assign(Error(message), { kind }),
};

test("Test connection names each provider once, without doubling a word", async () => {
  for (const [provider, name] of [
    ["torbox", "TorBox"],
    ["realdebrid", "Real-Debrid"],
    ["debridlink", "Debrid-Link"],
  ]) {
    const discovered = await plugin.test(config(provider, {}), host);
    assert("indexerName" in discovered, JSON.stringify(discovered));
    assert.equal(
      discovered.indexerName,
      `BookOrbit Debrid: Prowlarr indexer configuration and ${name} account access verified`,
    );
    const configured = await plugin.test(
      config(provider, { indexerPaths: "/1/api" }),
      host,
    );
    assert("indexerName" in configured, JSON.stringify(configured));
    assert.equal(
      configured.indexerName,
      `BookOrbit Debrid: indexer search and ${name} access verified`,
    );
  }
});

test("Test connection mentions a cached release only when it found one", async () => {
  const hash = "a".repeat(40);
  const result = await plugin.test(
    config("torbox", { indexerPaths: "/1/api" }),
    {
      ...host,
      async fetch(input, init) {
        const url = new URL(input);
        if (url.pathname === "/1/api")
          return new Response(
            `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Books</title><item><title>Pride and Prejudice</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`,
          );
        if (url.pathname.endsWith("/checkcached"))
          return Response.json({
            success: true,
            data: {
              [hash]: {
                hash,
                name: "Pride and Prejudice",
                files: [{ name: "Pride and Prejudice.epub", size: 100 }],
              },
            },
          });
        return host.fetch(input, init);
      },
    },
  );
  assert("indexerName" in result, JSON.stringify(result));
  assert.equal(
    result.indexerName,
    "BookOrbit Debrid: indexer search and TorBox access verified; a matching cached release was found",
  );
});

test("an invalid Show uncached downloads value is reported under the setting's label", async () => {
  const label = plugin.settingsFields.find(
    (field) => field.key === "prepareUncached",
  )!.label;
  assert.equal(label, "Show uncached downloads");
  const result = await plugin.test(
    config("torbox", { prepareUncached: "yes" }),
    host,
  );
  assert.equal(result.success, false);
  assert("error" in result);
  assert.equal(result.error, `${label} must be enabled or disabled.`);
});

const prideHash = "c".repeat(40);
const pride = `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Books</title><item><title>Pride and Prejudice</title><torznab:attr name="infohash" value="${prideHash}"/></item></channel></rss>`;
const empty = "<rss><channel><title>Books</title></channel></rss>";
const twoPaths = config("torbox", { indexerPaths: "/1/api,/2/api" });
const verified = "BookOrbit Debrid: indexer search and TorBox access verified";
/** Two configured feeds, each answered by its own function; TorBox holds the matching ebook. */
function twoFeeds(feeds: Record<string, () => Response | Promise<Response>>) {
  const warnings: string[] = [];
  const twoFeedHost: PluginHost = {
    ...host,
    async fetch(input, init) {
      const url = new URL(input);
      if (feeds[url.pathname]) return feeds[url.pathname]();
      if (url.pathname.endsWith("/checkcached"))
        return Response.json({
          success: true,
          data: {
            [prideHash]: {
              hash: prideHash,
              name: "Pride and Prejudice",
              files: [{ name: "Pride and Prejudice.epub", size: 100 }],
            },
          },
        });
      return host.fetch(input, init);
    },
    logger: { log() {}, warn: (message) => warnings.push(message) },
  };
  return { host: twoFeedHost, warnings };
}

test("Test connection fails on a configured feed that failed, although another feed holds a match", async () => {
  const feeds = {
    "/1/api": () => new Response("down", { status: 500 }),
    "/2/api": () => new Response(pride),
  };
  assert.deepEqual(await plugin.test(twoPaths, twoFeeds(feeds).host), {
    success: false,
    error: "/1/api: Torznab: HTTP 500. Retry later.",
  });
  // The same feeds through a search: the match is returned and the failure is only a warning.
  const f = twoFeeds(feeds);
  const releases = await plugin.search(
    {
      title: "Pride and Prejudice",
      author: "Jane Austen",
      isbn13: null,
      isbn13s: [],
      mediaKind: "ebook",
      language: "en",
      limit: 20,
    },
    twoPaths,
    f.host,
    new AbortController().signal,
  );
  assert.deepEqual(
    releases.map((release) => [release.title, release.format]),
    [["Pride and Prejudice · EPUB · Books · TorBox", "epub"]],
  );
  assert.deepEqual(f.warnings, ["/1/api: Torznab: HTTP 500. Retry later."]);
});

test("Test connection names every configured feed that failed", async () => {
  assert.deepEqual(
    await plugin.test(
      twoPaths,
      twoFeeds({
        "/1/api": () => new Response("down", { status: 500 }),
        "/2/api": () => new Response("<html>Sign in</html>"),
      }).host,
    ),
    {
      success: false,
      error:
        "/1/api: Torznab: HTTP 500. Retry later. /2/api: Not a Torznab feed. Use an indexer's API path, not the web interface.",
    },
  );
});

// Collection waits twelve seconds for every feed before a match elsewhere may end it, so this
// takes twelve seconds: inside the eighteen the whole test is given.
test("Test connection fails on a configured feed that never answered, although another feed holds a match", async () => {
  const start = performance.now();
  assert.deepEqual(
    await plugin.test(
      twoPaths,
      twoFeeds({
        "/1/api": () => new Promise<Response>(() => {}),
        "/2/api": () => new Response(pride),
      }).host,
    ),
    {
      success: false,
      error:
        "Indexer search timed out waiting for /1/api. Retry shortly; the first search after a restart can be slow.",
    },
  );
  assert(performance.now() - start < 13000);
});

// Feed 1 answers after four seconds and its lookup has ten more, so it is still checking when
// the match in feed 2 ends collection at twelve.
test("Test connection passes when a feed that answered is still checking a torrent link", async () => {
  const f = twoFeeds({
    "/1/api": async () => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return new Response(
        '<rss><channel><title>Books</title><item><title>Pride and Prejudice</title><enclosure type="application/x-bittorrent" url="/1/download?link=opaque"/></item></channel></rss>',
      );
    },
    "/1/download": () => new Promise<Response>(() => {}),
    "/2/api": () => new Response(pride),
  });
  assert.deepEqual(await plugin.test(twoPaths, f.host), {
    success: true,
    indexerName: `${verified}; a matching cached release was found`,
  });
  assert.deepEqual(f.warnings, [
    "Indexer search stopped while /1/api was still checking torrent links; matches already identified remain available.",
  ]);
});

test("Test connection with two working feeds mentions a cached release only when one holds a match", async () => {
  assert.deepEqual(
    await plugin.test(
      twoPaths,
      twoFeeds({
        "/1/api": () => new Response(empty),
        "/2/api": () => new Response(pride),
      }).host,
    ),
    {
      success: true,
      indexerName: `${verified}; a matching cached release was found`,
    },
  );
  assert.deepEqual(
    await plugin.test(
      twoPaths,
      twoFeeds({
        "/1/api": () => new Response(empty),
        "/2/api": () => new Response(empty),
      }).host,
    ),
    { success: true, indexerName: verified },
  );
});

// Feed 2 answers at seven seconds and its lookup has ten more, so nothing ends collection before
// its sixteen-second limit: the test takes sixteen seconds, inside the eighteen it is given.
test("Test connection passes when every feed answered, one is still checking a torrent link and none has a match", async () => {
  const feeds = {
    "/1/api": () => new Response(empty),
    "/2/api": async () => {
      await new Promise((resolve) => setTimeout(resolve, 7000));
      return new Response(
        '<rss><channel><title>Books</title><item><title>Pride and Prejudice</title><enclosure type="application/x-bittorrent" url="/2/download?link=opaque"/></item></channel></rss>',
      );
    },
    "/2/download": () => new Promise<Response>(() => {}),
  };
  const start = performance.now();
  const [result] = await Promise.all([
    plugin.test(twoPaths, twoFeeds(feeds).host),
    // The same feeds through a search still time out.
    assert.rejects(
      plugin.search(
        {
          title: "Pride and Prejudice",
          author: "Jane Austen",
          isbn13: null,
          isbn13s: [],
          mediaKind: "ebook",
          language: "en",
          limit: 1,
        },
        twoPaths,
        twoFeeds(feeds).host,
        new AbortController().signal,
      ),
      {
        kind: "timeout",
        message:
          "Indexer search timed out while /2/api was still checking torrent links. Retry shortly; the first search after a restart can be slow.",
      },
    ),
  ]);
  assert.deepEqual(result, { success: true, indexerName: verified });
  assert(performance.now() - start < 18000);
});
