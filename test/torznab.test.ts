import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { Network } from "../src/http.js";
import { searchFeeds } from "../src/torznab.js";
import type {
  PluginHost,
  PluginReleaseQuery,
} from "../vendor/bookorbit-plugin-api.js";

const key = "SYNTHETIC/INDEXER+KEY",
  hash = "a".repeat(40);
const endpoint = "http://indexer.example:9696/prowlarr/3/api";
const query: PluginReleaseQuery = {
  title: "Book",
  author: null,
  isbn13: null,
  isbn13s: [],
  mediaKind: "ebook",
  language: null,
  limit: 20,
};
const item = (url: string, title = "Book") =>
  `<item><title>${title}</title><enclosure type="application/x-bittorrent" url="${url.replaceAll("&", "&amp;")}"/></item>`;
const direct = `<item><title>Book</title><torznab:attr name="infohash" value="${hash}"/></item>`;
function fixture(items: string, reply: PluginHost["fetch"]) {
  const calls: URL[] = [],
    warnings: string[] = [];
  const host: PluginHost = {
    async fetch(input, init) {
      assert.equal(init?.redirect, "manual");
      assert(!init?.headers?.Authorization);
      const url = new URL(input);
      calls.push(url);
      if (url.pathname.endsWith("/api"))
        return new Response(
          `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Books</title>${items}</channel></rss>`,
        );
      return reply(input, init);
    },
    logger: { log() {}, warn: (message) => warnings.push(message) },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("unexpected credential write");
    },
    fail: (kind, message) => Object.assign(Error(message), { kind }),
  };
  // The hashes the feed made known, one entry each time it did.
  const reports: string[][] = [];
  const run = (signal?: AbortSignal, path = endpoint) => {
    const found: { hash: string }[] = [];
    return Effect.runPromise(
      searchFeeds(key, query)(path, (items) =>
        Effect.sync(() => {
          found.push(...items);
          reports.push(items.map((item) => item.hash));
        }),
      ).pipe(Effect.provideService(Network, host), Effect.as(found)),
      { signal },
    );
  };
  return { run, calls, warnings, reports };
}

test("Torznab resolves a same-origin download redirect to a magnet without requesting the magnet", async () => {
  const f = fixture(item("/prowlarr/3/download?link=opaque"), async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/prowlarr/3/download");
    assert.equal(url.searchParams.get("apikey"), key);
    return new Response(null, {
      status: 301,
      headers: { location: `magnet:?xt=urn:btih:${hash}` },
    });
  });
  assert.deepEqual(
    (await f.run()).map((item) => item.hash),
    [hash],
  );
  assert.equal(f.calls.length, 2);
});

const bytes = (...parts: (string | Uint8Array)[]) =>
  Buffer.concat(
    parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)),
  );
const info = bytes(
  "d6:lengthi123e4:name9:Book.epub12:piece lengthi16384e6:pieces20:",
  Uint8Array.from({ length: 20 }, (_, i) => i * 13),
  "e",
);
const torrent = (dictionary = info) => bytes("d4:info", dictionary, "e");
const expected = createHash("sha1").update(info).digest("hex");

test("direct Torznab info hashes and hex/base32 magnets require no metadata requests", async () => {
  const f = fixture(
    direct +
      item(`magnet:?xt=urn:btih:${hash}`) +
      item("magnet:?xt=urn:btih:VKVKVKVKVKVKVKVKVKVKVKVKVKVKVKVK") +
      direct.replace(
        "</item>",
        '<torznab:attr name="private" value=" TRUE "/></item>',
      ) +
      direct.replace(
        "</item>",
        '<torznab:attr name="private" value="0"/><indexer type="Private"/></item>',
      ) +
      item("/prowlarr/3/download?link=private").replace(
        "</item>",
        '<torznab:attr name="private" value="0"/><indexer type="Private"/></item>',
      ),
    async () => {
      throw Error("unexpected metadata request");
    },
  );
  assert.deepEqual(
    (await f.run()).map((item) => item.hash),
    [hash, hash, hash],
  );
  assert.equal(f.calls.length, 1);
});

test("Torznab hashes the exact raw binary info bytes in a same-origin torrent", async () => {
  const f = fixture(
    item("/prowlarr/3/download?link=torrent"),
    async () =>
      new Response(torrent(), {
        headers: { "content-type": "application/x-bittorrent" },
      }),
  );
  assert.deepEqual(
    (await f.run()).map((item) => item.hash),
    [expected],
  );
});

test("Jackett download paths retain only their own indexer authentication", async () => {
  const f = fixture(item("/jackett/dl/books/?path=opaque"), async (input) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get("jackett_apikey"), key);
    assert.equal(url.searchParams.has("apikey"), false);
    return new Response(null, {
      status: 302,
      headers: { location: `magnet:?xt=urn:btih:${hash}` },
    });
  });
  assert.equal(
    (
      await f.run(
        undefined,
        "https://indexer.example/jackett/api/v2.0/indexers/books/results/torznab/api",
      )
    )[0].hash,
    hash,
  );
});

test("metadata does not follow cross-origin/private redirects or arbitrary manager API links", async () => {
  for (const location of [
    "https://other.example/torrent",
    "http://127.0.0.1/torrent",
    `https://other.example/torrent?apikey=${encodeURIComponent(key)}`,
    "/api/v1/config",
  ]) {
    const f = fixture(
      direct + item("/prowlarr/3/download?link=opaque"),
      async () => new Response(null, { status: 301, headers: { location } }),
    );
    assert.deepEqual(
      (await f.run()).map((item) => item.hash),
      [hash],
    );
    assert.equal(f.calls.length, 2);
    assert(!f.warnings.join().includes(key));
    assert(!f.warnings.join().includes(location));
  }
  const f = fixture(
    direct + item("/api/v1/config") + item("https://other.example/3/download"),
    async () => {
      throw Error("untrusted request dispatched");
    },
  );
  assert.deepEqual(
    (await f.run()).map((item) => item.hash),
    [hash],
  );
  assert.equal(f.calls.length, 1);
});

test("metadata validates bencode boundaries, integers, duplicate keys, privacy and v1 identity", async () => {
  const malformed = [
    torrent().subarray(0, -1),
    bytes("d4:info", info, "4:info", info, "e"),
    torrent(
      bytes(
        "d6:lengthi-0e4:name9:Book.epub12:piece lengthi16384e6:pieces20:",
        new Uint8Array(20),
        "e",
      ),
    ),
    torrent(
      bytes(
        "d6:lengthi123e4:name09:Book.epub12:piece lengthi16384e6:pieces20:",
        new Uint8Array(20),
        "e",
      ),
    ),
    torrent(bytes("d6:lengthi123e4:name9:Book.epub12:meta versioni2ee")),
    torrent(bytes(info.subarray(0, -1), "7:privatei1ee")),
    torrent(bytes(info.subarray(0, -1), "7:private1:0e")),
    torrent(bytes(info.subarray(0, -1), "5:fileslee")),
    bytes("d4:info", "l".repeat(40), "e".repeat(41), "e"),
  ];
  for (const payload of malformed) {
    const f = fixture(
      direct + item("/prowlarr/3/download?link=invalid"),
      async () => new Response(payload),
    );
    assert.deepEqual(
      (await f.run()).map((item) => item.hash),
      [hash],
    );
    assert.equal(f.warnings.length, 1);
  }
});

test("metadata rejects challenges and enforces streamed size limits with cancellation", async () => {
  for (const html of [true, false]) {
    let cancelled = false;
    const f = fixture(
      direct + item("/prowlarr/3/download?link=large"),
      async () =>
        html
          ? new Response("<html>Checking your browser</html>", {
              headers: { "content-type": "text/html" },
            })
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(2 * 1024 ** 2 + 1));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            ),
    );
    assert.deepEqual(
      (await f.run()).map((item) => item.hash),
      [hash],
    );
    if (!html) assert(cancelled);
  }
});

test("metadata filters unrelated titles, deduplicates downloads and bounds fanout", async () => {
  let active = 0,
    peak = 0;
  const f = fixture(
    item("/prowlarr/3/download?link=unrelated", "Another novel") +
      Array.from({ length: 8 }, (_, n) =>
        item(`/prowlarr/3/download?link=${n}`),
      ).join("") +
      item("/prowlarr/3/download?link=0"),
    async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return new Response(null, {
        status: 301,
        headers: { location: `magnet:?xt=urn:btih:${hash}` },
      });
    },
  );
  assert.equal((await f.run()).length, 5);
  assert.equal(f.calls.length, 5);
  assert.equal(peak, 2);
  assert(!f.calls.some((url) => url.searchParams.get("link") === "unrelated"));
});

test("matching results beyond the torrent link lookup limit are reported once, without titles or links", async () => {
  const magnet: PluginHost["fetch"] = async () =>
    new Response(null, {
      status: 301,
      headers: { location: `magnet:?xt=urn:btih:${hash}` },
    });
  const links = (count: number) =>
    Array.from({ length: count }, (_, n) =>
      item(`/prowlarr/3/download?link=${n}`),
    ).join("");
  const f = fixture(links(6), magnet);
  assert.equal((await f.run()).length, 4);
  assert.deepEqual(f.warnings, [
    "Torznab: more than four matching results needed a torrent link lookup; the rest were left out.",
  ]);
  assert(!/Book|download|link=|SYNTHETIC/.test(f.warnings[0]), f.warnings[0]);
  const within = fixture(links(4), magnet);
  assert.equal((await within.run()).length, 4);
  assert.deepEqual(within.warnings, []);
});

test("metadata batch expiry retains direct and completed results beside a stalled lookup", async () => {
  const f = fixture(
    direct +
      item("/prowlarr/3/download?link=good") +
      item("/prowlarr/3/download?link=stalled"),
    async (input) =>
      new URL(input).searchParams.get("link") === "stalled"
        ? new Promise(() => {})
        : new Response(torrent()),
  );
  const empty = fixture(
    item("/prowlarr/3/download?link=stalled"),
    async () => new Promise(() => {}),
  );
  const [result] = await Promise.all([
    f.run(AbortSignal.timeout(12000)),
    assert.rejects(empty.run(AbortSignal.timeout(12000)), (error) => {
      assert(error instanceof Error && "kind" in error);
      assert.equal(error.kind, "timeout");
      return true;
    }),
  ]);
  assert.deepEqual(
    result.map((item) => item.hash),
    [hash, expected],
  );
  assert(f.warnings.some((message) => /budget expired/.test(message)));
});

test("caller cancellation cancels metadata response streams", async () => {
  let cancelled = false;
  const f = fixture(
    item("/prowlarr/3/download?link=stalled"),
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(f.run(AbortSignal.timeout(30)));
  assert(cancelled);
});

test("a feed makes its hashed results known in one step and each link when its lookup finishes", async () => {
  const other = "b".repeat(40);
  const f = fixture(
    direct +
      `<item><title>Book</title><torznab:attr name="infohash" value="${other}"/></item>` +
      item("/prowlarr/3/download?link=good") +
      item("/prowlarr/3/download?link=broken"),
    async (input) =>
      new URL(input).searchParams.get("link") === "good"
        ? new Response(torrent())
        : new Response(null, { status: 500 }),
  );
  await f.run();
  assert.deepEqual(f.reports, [[hash, other], [expected]]);
  // A feed with nothing to make known yet still says that it has answered.
  const links = fixture(
    item("/prowlarr/3/download?link=good"),
    async () => new Response(torrent()),
  );
  await links.run();
  assert.deepEqual(links.reports, [[], [expected]]);
});
