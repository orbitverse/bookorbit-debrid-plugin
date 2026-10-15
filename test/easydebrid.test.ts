import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as EasyDebrid from "../src/easydebrid.js";
import { Network } from "../src/http.js";
import type { SourceError } from "../src/model.js";
import type { PluginHost } from "../vendor/bookorbit-plugin-api.js";

const hash = "a".repeat(40),
  other = "b".repeat(40),
  key = "SYNTHETIC/EASY+ACCOUNT";
const selected = {
  hash,
  format: "epub",
  files: [{ name: "Book/book.epub", size: 100 }],
};
const generated = (url = "https://cdn.example/book?ticket=opaque") => ({
  files: [{ filename: "book.epub", directory: ["Book"], size: 100, url }],
});
function fixture(reply: (path: string) => Response) {
  const calls: { path: string; init: Parameters<PluginHost["fetch"]>[1] }[] =
      [],
    logs: string[] = [];
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, "https://easydebrid.com");
      assert.equal(url.search, "");
      assert.equal(init?.headers?.Authorization, `Bearer ${key}`);
      assert.equal(init?.redirect, "manual");
      calls.push({ path: url.pathname, init });
      return reply(url.pathname);
    },
    logger: { log: (s) => logs.push(s), warn: (s) => logs.push(s) },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("unexpected credential write");
    },
    fail: (_kind, message) => Error(message),
  };
  const run = <A>(effect: Effect.Effect<A, SourceError, Network>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Network, host)));
  return { calls, logs, run };
}

test("EasyDebrid maps only cached positional manifests without adding a torrent", async () => {
  const f = fixture(() =>
    Response.json({
      result: [
        {
          cached: true,
          files: [{ name: "book.epub", size: 100, folder: "Book" }],
        },
        { cached: false },
      ],
    }),
  );
  assert.deepEqual(await f.run(EasyDebrid.cached([hash, other], key)), [
    { hash, name: hash, files: selected.files },
  ]);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].path, /link\/lookupdetails$/);
  assert.deepEqual(JSON.parse(f.calls[0].init!.body!), {
    urls: [hash, other].map((h) => `magnet:?xt=urn:btih:${h}`),
  });
  assert.deepEqual(f.logs, []);
});

test("EasyDebrid rejects incomplete, malformed and missing cached manifests", async () => {
  for (const response of [
    { result: [] },
    { result: [{ cached: true }] },
    {
      result: [
        {
          cached: true,
          files: [{ name: "book.epub", folder: "Book", size: "100" }],
        },
      ],
    },
  ]) {
    const f = fixture(() => Response.json(response));
    await assert.rejects(f.run(EasyDebrid.cached([hash], key)));
    assert.equal(f.calls.length, 1);
  }
});

test("EasyDebrid matches the generated filename, directory and size before handoff", async () => {
  const f = fixture(() => Response.json(generated()));
  assert.equal(
    await f.run(EasyDebrid.resolve(selected, key)),
    "https://cdn.example/book?ticket=opaque",
  );
  assert.deepEqual(JSON.parse(f.calls[0].init!.body!), {
    url: `magnet:?xt=urn:btih:${hash}`,
  });
  for (const change of [
    { filename: "other.epub" },
    { directory: ["Other"] },
    { size: 101 },
  ]) {
    const bad = fixture(() =>
      Response.json({ files: [{ ...generated().files[0], ...change }] }),
    );
    await assert.rejects(
      bad.run(EasyDebrid.resolve(selected, key)),
      /changed or is unavailable/,
    );
  }
});

test("EasyDebrid rejects track ZIPs before requesting links and never retries generation", async () => {
  const f = fixture(() => {
    throw Error("synthetic network failure");
  });
  await assert.rejects(
    f.run(EasyDebrid.resolve({ ...selected, format: "zip" }, key)),
    /single-file/,
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    f.run(EasyDebrid.resolve(selected, key)),
    /could not connect/,
  );
  assert.equal(f.calls.length, 1);
});

test("EasyDebrid refuses account-bearing and unsafe URLs without exposing them in logs or errors", async () => {
  for (const url of [
    `https://cdn.example/book?token=${encodeURIComponent(key)}`,
    `https://cdn.example/book?token=${encodeURIComponent(encodeURIComponent(key))}`,
    `https://cdn.example/book?token=${encodeURIComponent(encodeURIComponent(encodeURIComponent(key)))}`,
    `https://cdn.example/book?token=${Buffer.from(key).toString("base64url")}`,
    "http://cdn.example/book",
    "https://127.0.0.1/book",
    "https://[::1]/book",
    "https://user:password@cdn.example/book",
    "https://api.local/book",
    "https://easydebrid.com/api/v1/link/generate",
  ]) {
    const f = fixture(() => Response.json(generated(url)));
    await assert.rejects(f.run(EasyDebrid.resolve(selected, key)), (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /safe direct download/);
      assert(!error.message.includes(key));
      assert(!error.message.includes(url));
      return true;
    });
    assert.deepEqual(f.logs, []);
  }
});

test("EasyDebrid account verification validates details and reports auth failures safely", async () => {
  const f = fixture(() => Response.json({ id: 123, paid_until: "2027-01-01" }));
  await f.run(EasyDebrid.verify(key));
  assert.equal(f.calls[0].path, "/api/v1/user/details");
  assert.equal(f.calls[0].init!.method, "GET");
  const denied = fixture(() => new Response(key, { status: 401 }));
  await assert.rejects(
    denied.run(EasyDebrid.verify(key)),
    /EasyDebrid: access denied/,
  );
  assert.equal(denied.calls.length, 1);
  assert.deepEqual(denied.logs, []);
});
