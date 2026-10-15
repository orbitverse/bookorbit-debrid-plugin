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
        debrid: { provider: "realdebrid", key: "x" },
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
