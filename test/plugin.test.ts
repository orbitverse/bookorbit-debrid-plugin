import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import { selectFiles } from "../src/books.js";
import type {
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

const hash = "a".repeat(40);
const secondHash = "b".repeat(40);
const providerKey = "SYNTHETIC_PROVIDER_KEY";
const cfg: PluginIndexerConfig = {
  id: 1,
  name: "Debrid",
  baseUrl: "http://prowlarr.example:9696",
  allowPrivateAddress: false,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/1/api" },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER_KEY",
    debrid: { provider: "torbox", key: providerKey },
  }),
};
const q: PluginReleaseQuery = {
  title: "The Little Prince",
  author: null,
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: null,
  limit: 20,
};
const ebook = { name: "The Little Prince.epub", size: 5000 };
const tracks = [1, 2, 3].map((n) => ({
  name: `The Little Prince/${String(n).padStart(2, "0")}.mp3`,
  size: n * 1000,
}));
const xml = (
  items = `<item><title>The Little Prince</title><torznab:attr name="infohash" value="${hash}"/></item>`,
) =>
  `<?xml version="1.0"?><rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Book indexer</title>${items}</channel></rss>`;
const json = (data: unknown) =>
  Response.json({ success: true, error: null, data });
function fixture(
  options: {
    files?: typeof tracks;
    miss?: boolean;
    evicted?: boolean;
    wrongHash?: boolean;
    extra?: boolean;
    link?: string;
    pending?: boolean;
  } = {},
) {
  const calls: { url: URL; init: Parameters<PluginHost["fetch"]>[1] }[] = [];
  let lookups = 0;
  const files = options.files ?? [ebook];
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      calls.push({ url, init });
      assert.equal(init?.redirect, "manual");
      if (url.hostname === "prowlarr.example") return new Response(xml());
      assert.equal(url.origin, "https://api.torbox.app");
      assert.equal(init?.headers?.Authorization, `Bearer ${providerKey}`);
      if (url.pathname.endsWith("checkcached")) {
        if (JSON.parse(init!.body!).hashes.length === 0) {
          assert.deepEqual(JSON.parse(init!.body!), { hashes: [] });
          return json({});
        }
        lookups++;
        assert.deepEqual(JSON.parse(init!.body!), { hashes: [hash] });
        return json(
          options.miss || (options.evicted && lookups > 1)
            ? {}
            : { [hash]: { hash, name: "The Little Prince", files } },
        );
      }
      if (url.pathname.endsWith("createtorrent")) {
        assert.match(init!.body!, /name="add_only_if_cached"\r\n\r\ntrue/);
        assert.match(init!.body!, new RegExp(hash));
        assert(!init!.body!.includes(providerKey));
        return json({
          hash: options.wrongHash ? secondHash : hash,
          torrent_id: 7,
        });
      }
      if (url.pathname.endsWith("mylist"))
        return json([
          {
            id: 7,
            hash,
            download_finished: !options.pending,
            download_present: true,
            files: [
              ...files.map((f, id) => ({ ...f, id })),
              ...(options.extra
                ? [{ id: 99, name: "Another book.mp3", size: 100 }]
                : []),
            ],
          },
        ]);
      if (url.pathname.endsWith("requestdl"))
        return json(
          options.link ??
            "https://cdn.example/signed-file?ticket=download-only-token",
        );
      throw Error("Unexpected endpoint");
    },
    logger: { log() {}, warn() {} },
    buildSearchText: (query) => query.title,
    async saveCredential() {
      throw Error("Unexpected credential write");
    },
    fail: (kind, message) => Object.assign(new Error(message), { kind }),
  };
  return { host, calls };
}

test("search is read-only and cache misses never add a torrent", async () => {
  const f = fixture({ miss: true });
  assert.deepEqual(
    await plugin.search(q, cfg, f.host, new AbortController().signal),
    [],
  );
  assert.equal(f.calls.length, 2);
  assert(f.calls.every((c) => !c.url.pathname.endsWith("createtorrent")));
});
test("cached ebook resolves using the atomic guard and a fresh CDN link", async () => {
  const f = fixture();
  const releases = await plugin.search(
    q,
    cfg,
    f.host,
    new AbortController().signal,
  );
  assert.equal(releases.length, 1);
  assert.equal(releases[0].format, "epub");
  assert(!releases[0].guid.includes(providerKey));
  const result = await plugin.resolveFile!(
    releases[0],
    cfg,
    f.host,
    new AbortController().signal,
  );
  assert.equal(result.fileName, "The Little Prince.epub");
  assert.equal(result.sizeBytes, 5000);
  assert.equal(new URL(result.url).hostname, "cdn.example");
  const download = f.calls.find((c) => c.url.pathname.endsWith("requestdl"))!;
  assert.equal(download.url.searchParams.get("file_id"), "0");
});
test("evicted cached release fails without adding or queueing", async () => {
  const f = fixture({ evicted: true });
  const [release] = await plugin.search(
    q,
    cfg,
    f.host,
    new AbortController().signal,
  );
  await assert.rejects(
    plugin.resolveFile!(release, cfg, f.host, new AbortController().signal),
    /no download was queued/,
  );
  assert(!f.calls.some((c) => c.url.pathname.endsWith("createtorrent")));
});
test("numbered audio tracks are handed off together as ZIP", async () => {
  const f = fixture({ files: tracks });
  const [release] = await plugin.search(
    { ...q, mediaKind: "audiobook" },
    cfg,
    f.host,
    new AbortController().signal,
  );
  assert.equal(release.format, "zip");
  const result = await plugin.resolveFile!(
    release,
    cfg,
    f.host,
    new AbortController().signal,
  );
  assert.equal(result.format, "zip");
  assert.equal(result.sizeBytes, null);
  const download = f.calls.find((c) => c.url.pathname.endsWith("requestdl"))!;
  assert.equal(download.url.searchParams.get("zip_link"), "true");
  assert.equal(download.url.searchParams.has("file_id"), false);
});
test("ambiguous archives, gaps, multiple folders and alternate M4B editions are excluded", () => {
  const query = { ...q, mediaKind: "audiobook" as const };
  for (const files of [
    [{ name: "The Little Prince.zip", size: 10 }],
    [tracks[0], tracks[2]],
    [tracks[0], { ...tracks[1], name: "Another book/02.mp3" }],
    [
      { name: "The Little Prince/01.m4b", size: 1 },
      { name: "The Little Prince/02.m4b", size: 2 },
    ],
  ])
    assert.deepEqual(selectFiles(files, query), []);
  assert.equal(
    selectFiles([{ name: "The Little Prince.m4b", size: 2 }], query).length,
    1,
  );
});
test("new unrelated media in an audiobook torrent prevents whole-torrent ZIP", async () => {
  const f = fixture({ files: tracks, extra: true });
  const [release] = await plugin.search(
    { ...q, mediaKind: "audiobook" },
    cfg,
    f.host,
    new AbortController().signal,
  );
  await assert.rejects(
    plugin.resolveFile!(release, cfg, f.host, new AbortController().signal),
    /additional books/,
  );
  assert(!f.calls.some((c) => c.url.pathname.endsWith("requestdl")));
});
test("pending and wrong-hash provider responses are never downloadable", async () => {
  for (const options of [{ pending: true }, { wrongHash: true }]) {
    const f = fixture(options);
    const [release] = await plugin.search(
      q,
      cfg,
      f.host,
      new AbortController().signal,
    );
    await assert.rejects(
      plugin.resolveFile!(release, cfg, f.host, new AbortController().signal),
    );
    assert(!f.calls.some((c) => c.url.pathname.endsWith("requestdl")));
  }
});
test("download URLs reject unsafe destinations and misplaced provider credentials", async () => {
  for (const link of [
    "http://cdn.example/book",
    "https://127.0.0.1/book",
    "https://[::1]/book",
    "https://nas.local/book",
    "https://localhost./book",
    "https://user:password@cdn.example/book",
    `https://cdn.example/book?token=${providerKey.replaceAll("_", "%5F")}`,
    `https://cdn.tb-cdn.st.example.com/book?token=${providerKey}`,
    `https://cdn.tb-cdn.st/book?key=${providerKey}`,
    `https://cdn.tb-cdn.st/book?token=presigned-${providerKey}-ticket`,
    `https://cdn.tb-cdn.st/book?token=${providerKey}&token=${providerKey}`,
    `https://cdn.tb-cdn.st/${providerKey}?token=${providerKey}`,
    `https://api.torbox.app/v1/api/torrents/requestdl?token=${providerKey}`,
  ]) {
    const f = fixture({ link });
    const [release] = await plugin.search(
      q,
      cfg,
      f.host,
      new AbortController().signal,
    );
    await assert.rejects(
      plugin.resolveFile!(release, cfg, f.host, new AbortController().signal),
      (error: Error) => {
        assert.match(error.message, /safe direct download/);
        assert(!error.message.includes(providerKey));
        assert(!error.message.includes(link));
        return true;
      },
    );
  }
});
test("configuration rejects unknown providers and cross-origin API paths before networking", async () => {
  const f = fixture();
  for (const changed of [
    {
      credential: JSON.stringify({
        indexerKey: "x",
        debrid: { provider: "unsupported-provider", key: "x" },
      }),
    },
    { settings: { indexerPaths: "//evil.example/api" } },
    { settings: { indexerPaths: "/api?apikey=secret" } },
  ]) {
    await assert.rejects(
      plugin.search(
        q,
        { ...cfg, ...changed },
        f.host,
        new AbortController().signal,
      ),
    );
  }
  assert.equal(f.calls.length, 0);
});
test("duplicate hashes are checked once and private torrents are excluded", async () => {
  const f = fixture();
  const fetch = f.host.fetch;
  f.host.fetch = async (input, init) =>
    new URL(input).hostname === "prowlarr.example"
      ? new Response(
          xml(
            `<item><title>The Little Prince</title><torznab:attr name="magneturl" value="magnet:?xt=urn:btih:${hash}"/></item><item><title>The Little Prince</title><torznab:attr name="infohash" value="${hash}"/></item><item><title>The Little Prince</title><torznab:attr name="infohash" value="${secondHash}"/><torznab:attr name="private" value="true"/></item>`,
          ),
        )
      : fetch(input, init);
  assert.equal(
    (await plugin.search(q, cfg, f.host, new AbortController().signal)).length,
    1,
  );
});
test("one broken feed does not suppress another feed's results", async () => {
  const f = fixture();
  const fetch = f.host.fetch;
  const warnings: string[] = [];
  f.host.logger.warn = (message) => warnings.push(message);
  f.host.fetch = async (input, init) =>
    new URL(input).pathname === "/2/api"
      ? new Response("bad", { status: 503 })
      : fetch(input, init);
  const releases = await plugin.search(
    q,
    { ...cfg, settings: { indexerPaths: "/1/api,/2/api" } },
    f.host,
    new AbortController().signal,
  );
  assert.equal(releases.length, 1);
  assert.equal(warnings.length, 1);
});
test("cancellation reaches a stalled search without returning partial candidates", async () => {
  const f = fixture();
  f.host.fetch = () => new Promise(() => {});
  const controller = new AbortController();
  const pending = plugin.search(q, cfg, f.host, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("a lone numbered chapter is not advertised as a complete audiobook", () => {
  const query = { ...q, mediaKind: "audiobook" as const };
  for (const name of [
    "The Little Prince/01.mp3",
    "The Little Prince - Chapter 1.mp3",
    "The Little Prince 01.mp3",
  ]) {
    assert.deepEqual(selectFiles([{ name, size: 1000 }], query), []);
  }
});

test("numbers in the requested book title are not chapter markers", () => {
  for (const title of ["Catch-22", "Fahrenheit 451", "The 39 Steps", "1984"]) {
    assert.equal(
      selectFiles([{ name: `${title}.m4b`, size: 1000 }], {
        title,
        mediaKind: "audiobook",
      }).length,
      1,
    );
  }
});

test("long complete track lists fit in stable release identifiers", async () => {
  const files = Array.from({ length: 60 }, (_, i) => ({
    name: `The Little Prince/${String(i + 1).padStart(2, "0")} - A descriptive chapter title for the audiobook.mp3`,
    size: 1000,
  }));
  const f = fixture({ files });
  const [release] = await plugin.search(
    { ...q, mediaKind: "audiobook" },
    cfg,
    f.host,
    new AbortController().signal,
  );
  assert(release, "complete cached book should not disappear");
  assert(release.guid.length < 1000);
  assert.equal(
    (
      await plugin.resolveFile!(
        release,
        cfg,
        f.host,
        new AbortController().signal,
      )
    ).format,
    "zip",
  );
});

test("oversized and malformed cache records do not hide a healthy book", async () => {
  const f = fixture();
  f.host.fetch = async (input) =>
    new URL(input).hostname === "prowlarr.example"
      ? new Response(
          xml(
            `<item><title>The Little Prince</title><torznab:attr name="infohash" value="${hash}"/></item><item><title>The Little Prince large edition</title><torznab:attr name="infohash" value="${secondHash}"/></item>`,
          ),
        )
      : json({
          [hash]: { hash, name: "The Little Prince", files: [ebook] },
          [secondHash]: {
            hash: secondHash,
            name: "The Little Prince",
            files: [{ name: ebook.name, size: 9 * 1024 ** 3 }],
          },
          unexpected: { files: "malformed" },
        });
  assert.equal(
    (await plugin.search(q, cfg, f.host, new AbortController().signal)).length,
    1,
  );
});

test("a usable six-second indexer response is kept within the search budget", async () => {
  const f = fixture();
  const fetch = f.host.fetch;
  f.host.fetch = async (input, init) => {
    if (new URL(input).hostname === "prowlarr.example")
      await new Promise((resolve) => setTimeout(resolve, 6000));
    return fetch(input, init);
  };
  const releases = await plugin.search(
    q,
    cfg,
    f.host,
    new AbortController().signal,
  );
  assert.equal(releases.length, 1);
});

test("native TorBox token links pass privately without entering search identifiers or logs", async () => {
  for (const suffix of ["cx", "io", "pw", "sh", "st", "to", "earth"]) {
    const link = `https://cdn.tb-cdn.${suffix}/dld/fixture?token=${providerKey}`;
    const f = fixture({ link });
    const logs: string[] = [];
    f.host.logger = {
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    };
    const [release] = await plugin.search(
      q,
      cfg,
      f.host,
      new AbortController().signal,
    );
    const file = await plugin.resolveFile!(
      release,
      cfg,
      f.host,
      new AbortController().signal,
    );
    assert.equal(file.url, link);
    assert(!JSON.stringify(release).includes(providerKey));
    assert(!JSON.stringify(logs).includes(providerKey));
    assert(!JSON.stringify(logs).includes(link));
  }
});

const publicIndexer = (id: number, category = 7020) => ({
  id,
  enable: true,
  supportsSearch: true,
  protocol: "torrent",
  privacy: "public",
  capabilities: { categories: [{ id: category }] },
});
function discoveryFixture(
  metadata: unknown,
  options: Parameters<typeof fixture>[0] = {},
) {
  const f = fixture(options);
  const fetch = f.host.fetch;
  const discovered: URL[] = [];
  f.host.fetch = async (input, init) => {
    const url = new URL(input);
    discovered.push(url);
    if (url.pathname.endsWith("/api/v1/indexer")) {
      assert.equal(init?.headers?.["X-Api-Key"], "SYNTHETIC_INDEXER_KEY");
      assert.equal(init?.headers?.Authorization, undefined);
      assert.equal(url.search, "");
      return Response.json(metadata);
    }
    return fetch(input, init);
  };
  return { ...f, discovered };
}

test("Prowlarr discovery searches only enabled public searchable torrent book feeds", async () => {
  const f = discoveryFixture([
    publicIndexer(1),
    { ...publicIndexer(2), privacy: "private" },
    { ...publicIndexer(3), privacy: "semiPrivate" },
    { ...publicIndexer(4), privacy: undefined },
    { ...publicIndexer(5), protocol: "usenet" },
    { ...publicIndexer(6), enable: false },
    { ...publicIndexer(7), supportsSearch: false },
    publicIndexer(8, 3030),
  ]);
  const releases = await plugin.search(
    q,
    { ...cfg, settings: null },
    f.host,
    new AbortController().signal,
  );
  assert.equal(releases.length, 1);
  assert.deepEqual(
    f.discovered
      .filter((u) => u.hostname === "prowlarr.example")
      .map((u) => u.pathname),
    ["/api/v1/indexer", "/1/api"],
  );
});

test("discovery follows nested audiobook categories and retains a reverse proxy base path", async () => {
  const f = discoveryFixture(
    [
      publicIndexer(1),
      {
        ...publicIndexer(2),
        capabilities: {
          categories: [{ id: 3000, subCategories: [{ id: 3030 }] }],
        },
      },
    ],
    { files: tracks },
  );
  const [release] = await plugin.search(
    { ...q, mediaKind: "audiobook" },
    {
      ...cfg,
      baseUrl: cfg.baseUrl + "/prowlarr",
      settings: { indexerPaths: "  " },
    },
    f.host,
    new AbortController().signal,
  );
  assert.equal(release.format, "zip");
  assert.deepEqual(
    f.discovered
      .filter((u) => u.hostname === "prowlarr.example")
      .map((u) => u.pathname),
    ["/prowlarr/api/v1/indexer", "/prowlarr/2/api"],
  );
});

test("empty, excessive and malformed discovery fail before any tracker is searched", async () => {
  for (const [metadata, message] of [
    [[publicIndexer(1, 3030)], /No enabled public ebook/],
    [
      Array.from({ length: 9 }, (_, i) => publicIndexer(i + 1)),
      /More than eight/,
    ],
    [[{ ...publicIndexer(1), id: "1" }], /not recognized/],
  ] as const) {
    const f = discoveryFixture(metadata);
    await assert.rejects(
      plugin.search(
        q,
        { ...cfg, settings: {} },
        f.host,
        new AbortController().signal,
      ),
      message,
    );
    assert.equal(f.discovered.length, 1);
    assert.equal(f.calls.length, 0);
  }
});

test("discovery denial never guesses or falls back to tracker paths", async () => {
  const f = fixture();
  let calls = 0;
  f.host.fetch = async () => {
    calls++;
    return new Response("denied", { status: 401 });
  };
  await assert.rejects(
    plugin.search(
      q,
      { ...cfg, settings: {} },
      f.host,
      new AbortController().signal,
    ),
    /Prowlarr: access denied/,
  );
  assert.equal(calls, 1);
});

test("explicit Torznab overrides bypass discovery and retain Jackett paths", async () => {
  const f = fixture();
  const paths = "/api/v2.0/indexers/book-feed/results/torznab/api";
  assert.equal(
    (
      await plugin.search(
        q,
        { ...cfg, settings: { indexerPaths: paths } },
        f.host,
        new AbortController().signal,
      )
    ).length,
    1,
  );
  assert.equal(f.calls[0].url.pathname, paths);
  assert(!f.calls.some((c) => c.url.pathname.endsWith("/api/v1/indexer")));
});

test("automatic connection test accepts audio-only indexers without searching a title", async () => {
  const f = discoveryFixture([publicIndexer(1, 3030)]);
  const result = await plugin.test({ ...cfg, settings: {} }, f.host);
  assert.equal(result.success, true);
  assert.match(
    result.indexerName!,
    /configuration and TorBox account access verified/,
  );
  assert.equal(f.discovered.length, 2);
  assert(f.discovered.some((u) => u.pathname.endsWith("/api/v1/indexer")));
  assert(f.discovered.some((u) => u.pathname.endsWith("/checkcached")));
  assert(!f.discovered.some((u) => u.searchParams.has("q")));
});

test("automatic connection test rejects servers without either book category", async () => {
  const f = discoveryFixture([publicIndexer(1, 5000)]);
  const result = await plugin.test({ ...cfg, settings: {} }, f.host);
  assert.equal(result.success, false);
  assert("error" in result);
  assert.match(result.error, /No enabled public ebook or audiobook/);
  assert.equal(f.discovered.length, 2);
});

const easyCfg: PluginIndexerConfig = {
  ...cfg,
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER_KEY",
    debrid: { provider: "easydebrid", key: providerKey },
  }),
};
function easyPluginFixture(
  options: { evicted?: boolean; changed?: boolean; audioTracks?: boolean } = {},
) {
  const f = fixture();
  const fetch = f.host.fetch;
  const calls: string[] = [];
  let lookups = 0;
  f.host.fetch = async (input, init) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.hostname !== "easydebrid.com") return fetch(input, init);
    assert.equal(init?.headers?.Authorization, `Bearer ${providerKey}`);
    assert.equal(init?.redirect, "manual");
    if (url.pathname.endsWith("lookupdetails")) {
      lookups++;
      assert.deepEqual(JSON.parse(init!.body!), {
        urls: [`magnet:?xt=urn:btih:${hash}`],
      });
      return Response.json({
        result: [
          {
            cached: !(options.evicted && lookups > 1),
            files: (options.audioTracks ? tracks : [ebook]).map((file) => ({
              name: file.name.split("/").pop(),
              folder: file.name.includes("/") ? "The Little Prince" : "",
              size: file.size + (options.changed && lookups > 1 ? 1 : 0),
            })),
          },
        ],
      });
    }
    assert.equal(url.pathname, "/api/v1/link/generate");
    assert.deepEqual(JSON.parse(init!.body!), {
      url: `magnet:?xt=urn:btih:${hash}`,
    });
    return Response.json({
      files: [
        {
          filename: ebook.name,
          directory: [],
          size: ebook.size,
          url: "https://cdn.example/book.epub?ticket=opaque",
        },
      ],
    });
  };
  return { ...f, calls };
}

test("EasyDebrid plugin search is read-only and resolution rechecks before generating a link", async () => {
  const f = easyPluginFixture();
  const [release] = await plugin.search(
    q,
    easyCfg,
    f.host,
    new AbortController().signal,
  );
  assert.equal(JSON.parse(release.guid).provider, "easydebrid");
  assert.match(release.title, /EasyDebrid/);
  assert(!release.guid.includes(providerKey));
  assert.deepEqual(f.calls, ["/1/api", "/api/v1/link/lookupdetails"]);
  const file = await plugin.resolveFile!(
    release,
    easyCfg,
    f.host,
    new AbortController().signal,
  );
  assert.deepEqual(file, {
    url: "https://cdn.example/book.epub?ticket=opaque",
    fileName: ebook.name,
    sizeBytes: ebook.size,
    format: "epub",
  });
  assert.deepEqual(f.calls.slice(2), [
    "/api/v1/link/lookupdetails",
    "/api/v1/link/generate",
  ]);
});

test("changing a release's configured provider rejects resolution before networking", async () => {
  const f = easyPluginFixture();
  const [release] = await plugin.search(
    q,
    easyCfg,
    f.host,
    new AbortController().signal,
  );
  const before = f.calls.length;
  await assert.rejects(
    plugin.resolveFile!(release, cfg, f.host, new AbortController().signal),
    /provider changed/,
  );
  assert.equal(f.calls.length, before);
});

test("EasyDebrid eviction or changed manifest prevents link generation through the plugin", async () => {
  for (const options of [{ evicted: true }, { changed: true }]) {
    const f = easyPluginFixture(options);
    const [release] = await plugin.search(
      q,
      easyCfg,
      f.host,
      new AbortController().signal,
    );
    await assert.rejects(
      plugin.resolveFile!(
        release,
        easyCfg,
        f.host,
        new AbortController().signal,
      ),
      /no download was queued/,
    );
    assert.equal(
      f.calls.filter((path) => path.endsWith("lookupdetails")).length,
      2,
    );
    assert(!f.calls.some((path) => path.endsWith("generate")));
  }
});

test("EasyDebrid plugin omits tracksets that it cannot deliver as a complete ZIP", async () => {
  const f = easyPluginFixture({ audioTracks: true });
  assert.deepEqual(
    await plugin.search(
      { ...q, mediaKind: "audiobook" },
      easyCfg,
      f.host,
      new AbortController().signal,
    ),
    [],
  );
  assert(!f.calls.some((path) => path.endsWith("generate")));
});
