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
  baseUrl: "http://indexer.example:9696",
  allowPrivateAddress: true,
  categories: { ebook: [7020], audiobook: [3030] },
  settings: { indexerPaths: "/3/api" },
  credential: JSON.stringify({
    indexerKey: "SYNTHETIC_INDEXER",
    debrid: { provider: "torbox", key: "SYNTHETIC_PROVIDER" },
  }),
};
// The download link redirects to itself `redirects` times, then to a magnet.
function fixture(redirects: number) {
  let downloads = 0;
  const host: PluginHost = {
    async fetch(input) {
      const url = new URL(input);
      if (url.pathname === "/3/api")
        return new Response(
          '<rss><channel><title>Books</title><item><title>Book</title><enclosure url="/3/download?link=book"/></item></channel></rss>',
        );
      if (url.pathname === "/3/download") {
        const location =
          downloads++ < redirects
            ? `/3/download?link=book&hop=${downloads}`
            : `magnet:?xt=urn:btih:${hash}`;
        return new Response(null, { status: 302, headers: { location } });
      }
      assert.equal(url.origin, "https://api.torbox.app");
      assert(url.pathname.endsWith("/checkcached"));
      return Response.json({
        success: true,
        data: {
          [hash]: {
            hash,
            name: "Book",
            files: [{ name: "Book.epub", size: 100 }],
          },
        },
      });
    },
    logger: { log() {}, warn() {} },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  return { host, downloads: () => downloads };
}
const search = (host: PluginHost) =>
  plugin.search(query, config, host, AbortSignal.timeout(1000));

test("a magnet is accepted after three same-origin redirects", async () => {
  const f = fixture(3);
  const releases = await search(f.host);
  assert.equal(releases.length, 1);
  assert.equal(JSON.parse(releases[0].guid).hash, hash);
  assert.equal(f.downloads(), 4);
});

test("a fourth redirect is still rejected without another request", async () => {
  const f = fixture(4);
  assert.deepEqual(await search(f.host), []);
  assert.equal(f.downloads(), 4);
});

const unresolved =
  "Torznab: a matching result's torrent metadata could not be resolved; other results remain available.";
// The feed's match needs a torrent link lookup, answered by `download`; with `direct` the feed
// also carries a result that needs none.
function lookup(download: () => Response, direct = false) {
  const warnings: string[] = [];
  const host: PluginHost = {
    ...fixture(0).host,
    async fetch(input) {
      const url = new URL(input);
      if (url.pathname === "/3/api")
        return new Response(
          `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Books</title><item><title>Book</title><enclosure url="/3/download?link=book"/></item>${
            direct
              ? `<item><title>Book</title><torznab:attr name="infohash" value="${hash}"/></item>`
              : ""
          }</channel></rss>`,
        );
      if (url.pathname === "/3/download") return download();
      assert(url.pathname.endsWith("/checkcached"));
      return Response.json({
        success: true,
        data: direct
          ? {
              [hash]: {
                hash,
                name: "Book",
                files: [{ name: "Book.epub", size: 100 }],
              },
            }
          : {},
      });
    },
    logger: { log() {}, warn: (message) => warnings.push(message) },
  };
  return { host, warnings };
}
// A body that delivers `sent`, then does `then` when more is asked for.
const body = (
  sent: Uint8Array,
  then: (controller: ReadableStreamDefaultController) => void,
) =>
  new Response(
    new ReadableStream({
      start: (controller) => controller.enqueue(sent),
      pull: then,
    }),
  );
const text = (value: string) => new TextEncoder().encode(value);

test("a torrent link whose body breaks off mid-read is unreachable, as one that never answers is", async () => {
  const broken = () =>
    body(text("d4:info"), (controller) =>
      controller.error(Error("connection reset")),
    );
  // Nothing else is known: the feed fails, and the failure names the feed's path.
  const alone = lookup(broken);
  await assert.rejects(search(alone.host), (error) => {
    assert(error instanceof Error && "kind" in error);
    assert.equal(error.kind, "unreachable");
    assert.equal(
      error.message,
      "/3/api: Torznab: a matching result's torrent link could not be reached. Retry later.",
    );
    return true;
  });
  assert.deepEqual(alone.warnings, []);
  // Beside a result the feed already knows it is only a warning.
  const beside = lookup(broken, true);
  const releases = await search(beside.host);
  assert.equal(releases.length, 1);
  assert.equal(JSON.parse(releases[0].guid).hash, hash);
  assert.deepEqual(beside.warnings, [unresolved]);
});

test("a torrent body that arrives whole is an answer even when it is not a usable torrent", async () => {
  for (const download of [
    // Cut short as a torrent, but the response itself completed.
    () =>
      body(text("d4:infod4:name4:Book"), (controller) => controller.close()),
    // More than the size limit, streamed without a declared length.
    () =>
      body(new Uint8Array(2 * 1024 ** 2), (controller) =>
        controller.enqueue(new Uint8Array(1)),
      ),
  ]) {
    const f = lookup(download);
    assert.deepEqual(await search(f.host), []);
    assert.deepEqual(f.warnings, [unresolved]);
  }
});

test("cancelling while a torrent body is being read is a cancellation, not an unreachable link", async () => {
  const caller = new AbortController();
  // The connection is torn down with the caller, as a real one is.
  const f = lookup(() =>
    body(text("d4:info"), (controller) => {
      caller.signal.addEventListener("abort", () =>
        controller.error(Error("aborted")),
      );
      setTimeout(() => caller.abort(), 10);
    }),
  );
  await assert.rejects(
    plugin.search(query, config, f.host, caller.signal),
    (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /cancelled/);
      assert(!/reached/.test(error.message), error.message);
      return true;
    },
  );
  assert.deepEqual(f.warnings, []);
});
