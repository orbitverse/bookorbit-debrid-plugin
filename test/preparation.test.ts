import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import type {
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

const hash = "c".repeat(40);
const key = "SYNTHETIC_PREPARATION_ACCOUNT";
const cfg: PluginIndexerConfig = {
  id: 1,
  name: "Debrid",
  baseUrl: "https://indexer.example",
  allowPrivateAddress: false,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/1/api", prepareUncached: true },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER",
    debrid: { provider: "torbox", key },
  }),
};
const query: PluginReleaseQuery = {
  title: "The Little Prince",
  author: null,
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: null,
  limit: 20,
};
const file = { id: 1, name: "The Little Prince.epub", size: 5000 };
function fixture(cached = false) {
  const calls: string[] = [];
  let phase: "absent" | "preparing" | "ready" = "absent";
  const job = () => ({
    id: 4,
    hash,
    name: "The Little Prince",
    download_state: phase === "ready" ? "completed" : "downloading",
    download_finished: phase === "ready",
    download_present: phase === "ready",
    files: phase === "ready" ? [file] : [],
  });
  const envelope = (data: unknown) =>
    Response.json({ success: true, error: null, data });
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(init?.redirect, "manual");
      calls.push(url.pathname);
      if (url.hostname === "indexer.example")
        return new Response(
          `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Books</title><item><title>The Little Prince EPUB</title><torznab:attr name="infohash" value="${hash}"/></item><item><title>The Little Prince alternate</title><torznab:attr name="infohash" value="${"d".repeat(40)}"/></item></channel></rss>`,
        );
      assert.equal(url.origin, "https://api.torbox.app");
      assert.equal(init?.headers?.Authorization, `Bearer ${key}`);
      if (url.pathname.endsWith("checkcached"))
        return envelope(
          cached
            ? { [hash]: { hash, name: "The Little Prince", files: [file] } }
            : {},
        );
      if (url.pathname.endsWith("mylist"))
        return envelope(phase === "absent" ? [] : [job()]);
      if (url.pathname.endsWith("createtorrent")) {
        assert.match(init!.body!, /name="add_only_if_cached"\r\n\r\nfalse/);
        phase = "preparing";
        return envelope({ torrent_id: 4, hash });
      }
      assert(url.pathname.endsWith("requestdl"));
      assert.equal(phase, "ready");
      return envelope("https://cdn.example/little-prince.epub?ticket=opaque");
    },
    logger: { log() {}, warn() {} },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("Unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  return {
    host,
    calls,
    ready: () => {
      phase = "ready";
    },
  };
}
const signal = () => new AbortController().signal;

test("uncached preparation is opt-in, read-only in search and explicit in result metadata", async () => {
  assert.equal(
    plugin.settingsFields?.find((field) => field.key === "prepareUncached")
      ?.default,
    false,
  );
  const f = fixture();
  const disabled = { ...cfg, settings: { indexerPaths: "/1/api" } };
  assert.deepEqual(await plugin.search(query, disabled, f.host, signal()), []);
  const results = await plugin.search(query, cfg, f.host, signal());
  assert.equal(results.length, 1);
  const [release] = results;
  assert.match(release.title, /Prepare in TorBox.*download later/);
  assert(!release.title.includes("EPUB"));
  assert.equal(release.format, undefined);
  assert.equal(release.primaryFileCount, undefined);
  assert.equal(release.sizeBytes, null);
  assert.equal(release.downloadUrl, undefined);
  assert(!release.guid.includes(key));
  assert.equal(JSON.parse(release.guid).action, "prepare");
  assert(!f.calls.some((c) => /createtorrent|requestdl/.test(c)));
  const before = f.calls.length;
  await assert.rejects(
    plugin.resolveFile!(release, disabled, f.host, signal()),
    /Enable Show uncached downloads/,
  );
  assert.equal(f.calls.length, before);
});

test("selected uncached release prepares once, then later search validates and delivers the ready account file", async () => {
  const f = fixture();
  const [release] = await plugin.search(query, cfg, f.host, signal());
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      plugin.resolveFile!(release, cfg, f.host, signal()),
      (error) => {
        assert(error instanceof Error);
        assert.match(error.message, /Preparing.*debrid account/);
        assert.match(error.message, /BookOrbit may show this as an error/);
        assert.match(error.message, /Search again later to download/);
        assert.match(error.message, /will not continue automatically/);
        return true;
      },
    );
  assert.equal(f.calls.filter((c) => c.endsWith("createtorrent")).length, 1);
  assert(!f.calls.some((c) => c.endsWith("requestdl")));
  f.ready();
  await assert.rejects(
    plugin.resolveFile!(release, cfg, f.host, signal()),
    /ready.*Search again/,
  );
  const [ready] = await plugin.search(query, cfg, f.host, signal());
  assert.equal(ready.format, "epub");
  assert(!ready.title.includes("Prepare"));
  const download = await plugin.resolveFile!(ready, cfg, f.host, signal());
  assert.equal(download.fileName, "The Little Prince.epub");
  assert.equal(download.sizeBytes, file.size);
  assert.equal(
    download.url,
    "https://cdn.example/little-prince.epub?ticket=opaque",
  );
  assert.equal(f.calls.filter((c) => c.endsWith("createtorrent")).length, 1);
});

test("a ready file suppresses uncached alternatives so automatic grabs cannot queue them", async () => {
  const f = fixture(true);
  const releases = await plugin.search(query, cfg, f.host, signal());
  assert.equal(releases.length, 1);
  assert.equal(releases[0].format, "epub");
  assert(!releases[0].title.includes("Prepare"));
  assert(!f.calls.some((c) => /createtorrent|requestdl/.test(c)));
});
