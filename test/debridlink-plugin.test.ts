import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.js";
import type {
  PluginHost,
  PluginIndexerConfig,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

const hash = "f".repeat(40);
const key = "SYNTHETIC_DEBRIDLINK_TOKEN";
const config: PluginIndexerConfig = {
  id: 1,
  name: "Debrid",
  baseUrl: "https://indexer.example",
  allowPrivateAddress: false,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/1/api", prepareUncached: true },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER_KEY",
    debrid: { provider: "debridlink", key },
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
const link = "https://cdn.example/little-prince.epub?ticket=opaque";
function fixture(initial: "absent" | "ready" = "ready") {
  let phase: "absent" | "preparing" | "ready" = initial;
  const calls: string[] = [];
  const file = {
    id: "file1",
    name: "The Little Prince.epub",
    size: 5000,
    downloadUrl: link,
    downloadPercent: 100,
  };
  const job = (detail = true) => ({
    id: "torrent1",
    hashString: hash,
    name: "The Little Prince",
    status: phase === "ready" ? 100 : 1,
    downloadPercent: phase === "ready" ? 100 : 0,
    isZip: true,
    zip: {},
    files:
      phase !== "ready"
        ? []
        : detail
          ? [file]
          : [{ ...file, id: "generatedZip", name: "The Little Prince.zip" }],
  });
  const envelope = (value: unknown) =>
    Response.json({
      success: true,
      value,
      pagination: { page: 0, pages: 1, next: -1, previous: -1 },
    });
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(init?.redirect, "manual");
      assert(!input.includes(key));
      calls.push(url.pathname + (url.searchParams.has("ids") ? "?detail" : ""));
      if (url.hostname === "indexer.example")
        return new Response(
          `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Books</title><item><title>The Little Prince</title><torznab:attr name="infohash" value="${hash}"/></item></channel></rss>`,
        );
      assert.equal(url.origin, "https://debrid-link.com");
      assert.equal(init?.headers?.Authorization, `Bearer ${key}`);
      if (url.pathname === "/api/v2/seedbox/list")
        return envelope(
          phase === "absent" ? [] : [job(url.searchParams.has("ids"))],
        );
      assert.equal(url.pathname, "/api/v2/seedbox/add");
      const body = init!.headers?.["Content-Type"]?.includes("json")
        ? JSON.parse(init!.body!)
        : Object.fromEntries(new URLSearchParams(init!.body!));
      assert.equal(body.url, `magnet:?xt=urn:btih:${hash}`);
      phase = "preparing";
      return envelope(job());
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

test("Debrid-Link search expands ZIP summaries and returns ready account files without mutations", async () => {
  const f = fixture();
  const [release] = await plugin.search(query, config, f.host, signal());
  assert.match(release.title, /Debrid-Link account/);
  assert.equal(release.format, "epub");
  assert(!release.guid.includes(key));
  assert(f.calls.some((call) => call.endsWith("?detail")));
  assert(!f.calls.some((call) => call.endsWith("/add")));
  const file = await plugin.resolveFile!(release, config, f.host, signal());
  assert.equal(file.url, link);
  assert.equal(file.sizeBytes, 5000);
  assert.equal(file.fileName, "The Little Prince.epub");
  assert(!f.calls.some((call) => call.endsWith("/add")));
});

test("Debrid-Link selected preparation reuses its job and later resolves the verified ready file", async () => {
  const f = fixture("absent");
  const [preparation] = await plugin.search(query, config, f.host, signal());
  assert.match(preparation.title, /Prepare in Debrid-Link account/);
  assert.equal(preparation.format, undefined);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      plugin.resolveFile!(preparation, config, f.host, signal()),
      /Preparing/,
    );
  assert.equal(f.calls.filter((call) => call.endsWith("/add")).length, 1);
  f.ready();
  await assert.rejects(
    plugin.resolveFile!(preparation, config, f.host, signal()),
    /ready.*Search again/,
  );
  const [release] = await plugin.search(query, config, f.host, signal());
  assert.equal(release.format, "epub");
  assert.equal(
    (await plugin.resolveFile!(release, config, f.host, signal())).url,
    link,
  );
  assert.equal(f.calls.filter((call) => call.endsWith("/add")).length, 1);
});
