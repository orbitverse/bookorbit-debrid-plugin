import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as DL from "../src/debridlink.js";
import { Network } from "../src/http.js";
import type { SourceError } from "../src/model.js";
import type { PluginHost } from "../vendor/bookorbit-plugin-api.js";

const hash = "a".repeat(40),
  other = "b".repeat(40),
  key = "SYNTHETIC/DL+KEY";
const file = {
  id: "file1",
  name: "Book.epub",
  size: 123,
  downloadUrl: "https://seed20.debrid.link/dl/opaque",
  downloadPercent: 100,
};
const job = (changes = {}) => ({
  id: "job1",
  hashString: hash,
  name: "Book",
  status: 8,
  downloadPercent: 100,
  isZip: false,
  files: [file],
  ...changes,
});
const pagination = { page: 0, pages: 1, next: -1, previous: -1 };
const envelope = (value: unknown, extra = {}) =>
  Response.json({ success: true, value, ...extra });
const context = { title: "Book", mediaKind: "ebook" as const };
const selection = {
  hash,
  files: [{ name: "Book.epub", size: 123 }],
  format: "epub",
};
function fixture(
  options: {
    jobs?: () => unknown[];
    details?: (id: string) => unknown;
    pagination?: unknown;
    add?: () => Promise<Response>;
  } = {},
) {
  const calls: { route: string; method: string; body: unknown }[] = [],
    logs: string[] = [];
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, "https://debrid-link.com");
      assert.equal(init?.headers?.Authorization, `Bearer ${key}`);
      assert.equal(init?.redirect, "manual");
      const route = url.pathname.replace("/api/v2/", "");
      calls.push({
        route,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : null,
      });
      if (route === "account/infos")
        return envelope({ accountType: 1, premiumLeft: 100 });
      if (route === "seedbox/add") {
        assert.deepEqual(JSON.parse(init!.body!), {
          url: `magnet:?xt=urn:btih:${hash}`,
          wait: false,
          structureType: "list",
        });
        return options.add?.() ?? envelope({ id: "job1", hashString: hash });
      }
      assert.equal(route, "seedbox/list");
      const id = url.searchParams.get("ids");
      if (id) return envelope([options.details?.(id) ?? job()]);
      assert.equal(url.search, "?structureType=list&page=0&perPage=100");
      return envelope(options.jobs?.() ?? [job()], {
        pagination:
          options.pagination === undefined ? pagination : options.pagination,
      });
    },
    logger: { log: (s) => logs.push(s), warn: (s) => logs.push(s) },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("unexpected credential change");
    },
    fail: (_kind, message) => Error(message),
  };
  const run = <A>(
    effect: Effect.Effect<A, SourceError, Network>,
    signal?: AbortSignal,
  ) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Network, host)), {
      signal,
    });
  return { calls, logs, host, run };
}
const writes = (calls: ReturnType<typeof fixture>["calls"]) =>
  calls.filter((c) => c.method === "POST");

test("Debrid-Link exposes only requested ready account files after fetching full details", async () => {
  const f = fixture({
    jobs: () => [
      job({ isZip: true, files: [{ ...file, name: "aggregate.zip" }] }),
      job({ id: "other", hashString: other }),
    ],
    details: () => job({ isZip: true }),
  });
  assert.deepEqual(await f.run(DL.cached([hash], key)), [
    { hash, name: "Book", files: selection.files },
  ]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(writes(f.calls), []);
  assert.equal(await f.run(DL.resolve(selection, key)), file.downloadUrl);
  assert.deepEqual(writes(f.calls), []);
  await f.run(DL.verify(key));
  assert.equal(f.calls.at(-1)!.route, "account/infos");
});

test("Debrid-Link accepts both documented singleton page conventions but rejects incomplete inventory", async () => {
  const zero = fixture({ pagination: { ...pagination, pages: 0 } });
  assert.equal((await zero.run(DL.cached([hash], key))).length, 1);
  for (const p of [
    null,
    { ...pagination, next: 1 },
    { ...pagination, pages: 2 },
    { ...pagination, page: 1 },
    { ...pagination, previous: 0 },
  ]) {
    const f = fixture({ pagination: p });
    await assert.rejects(f.run(DL.prepare(hash, key, context)));
    assert.deepEqual(writes(f.calls), []);
  }
  const many = fixture({
    jobs: () => Array.from({ length: 9 }, (_, i) => job({ id: `job${i}` })),
  });
  await assert.rejects(many.run(DL.cached([hash], key)), /more than eight/);
  assert.equal(many.calls.length, 1);
});

test("Debrid-Link does not promote partial audio or unavailable files into a ready manifest", async () => {
  for (const change of [
    { status: 1 },
    { status: 4 },
    { status: 999 },
    { downloadPercent: 99 },
    { files: [{ ...file, downloadPercent: 99 }] },
    { files: [{ ...file, downloadUrl: "" }] },
    { srvMaint: true },
    {
      files: [
        file,
        { ...file, id: "file2", name: "Book/02.mp3", downloadPercent: 0 },
      ],
    },
  ]) {
    const f = fixture({ details: () => job(change) });
    assert.deepEqual(await f.run(DL.cached([hash], key)), []);
    assert.deepEqual(writes(f.calls), []);
  }
});

test("Debrid-Link binds refreshed file size, name, ID and hash before native URL handoff", async () => {
  for (const change of [
    { hashString: other },
    { id: "wrong" },
    { files: [{ ...file, name: "Other.epub" }] },
    { files: [{ ...file, size: 124 }] },
    { files: [file, { ...file, id: "file2" }] },
  ]) {
    const f = fixture({ details: () => job(change) });
    await assert.rejects(f.run(DL.resolve(selection, key)));
    assert.deepEqual(writes(f.calls), []);
  }
});

test("Debrid-Link refuses unsafe native URLs without logging secrets or response text", async () => {
  const sameHostUrl = "https://debrid-link.com/assets/book.epub";
  const safe = fixture({
    details: () => job({ files: [{ ...file, downloadUrl: sameHostUrl }] }),
  });
  assert.equal(await safe.run(DL.resolve(selection, key)), sameHostUrl);
  for (const downloadUrl of [
    "http://seed20.debrid.link/book",
    "https://127.0.0.1/book",
    "https://[::1]/book",
    "https://user:pass@cdn.example/book",
    "https://debrid-link.com/api/v2/seedbox/list",
    "https://api.debrid-link.com/file.epub",
    `https://cdn.example/book?token=${encodeURIComponent(key)}`,
  ]) {
    const f = fixture({
      details: () => job({ files: [{ ...file, downloadUrl }] }),
    });
    await assert.rejects(f.run(DL.resolve(selection, key)), (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /safe direct download/);
      assert(!error.message.includes(key));
      assert(!error.message.includes(downloadUrl));
      return true;
    });
    assert.deepEqual(f.logs, []);
  }
});

test("Debrid-Link preparation adds one magnet only after proving exact hash absence", async () => {
  const f = fixture({ jobs: () => [job({ hashString: other })] });
  assert.deepEqual(await f.run(DL.prepare(hash, key, context)), {
    status: "preparing",
  });
  assert.equal(writes(f.calls).length, 1);
});

test("Debrid-Link reuses pending, paused and ready account jobs without restarting", async () => {
  const incomplete = fixture({
    details: () => ({ id: "job1", hashString: hash }),
  });
  assert.deepEqual(await incomplete.run(DL.prepare(hash, key, context)), {
    status: "preparing",
  });
  assert.deepEqual(await incomplete.run(DL.cached([hash], key)), []);
  assert.deepEqual(writes(incomplete.calls), []);
  for (const status of [0, 1, 2, 4, 999]) {
    const f = fixture({
      details: () => job({ status, downloadPercent: 0, files: [] }),
    });
    assert.deepEqual(await f.run(DL.prepare(hash, key, context)), {
      status: "preparing",
    });
    assert.deepEqual(writes(f.calls), []);
  }
  const f = fixture();
  assert.deepEqual(await f.run(DL.prepare(hash, key, context)), {
    status: "ready",
  });
  assert.deepEqual(writes(f.calls), []);
});

test("Debrid-Link does not treat aggregate ZIPs or chapter tracks as complete single audio", async () => {
  const audioContext = { title: "Book", mediaKind: "audiobook" as const };
  for (const files of [
    [{ ...file, name: "Book.zip" }],
    [{ ...file, name: "Book Chapter 1.mp3" }],
    [1, 2].map((id) => ({ ...file, id: `file${id}`, name: `Book/${id}.mp3` })),
  ]) {
    const f = fixture({ details: () => job({ isZip: true, files }) });
    await assert.rejects(
      f.run(DL.prepare(hash, key, audioContext)),
      /complete single-file/,
    );
    assert.deepEqual(writes(f.calls), []);
  }
  const f = fixture({
    details: () =>
      job({ files: [file, { ...file, id: "pdf", name: "Book.pdf" }] }),
  });
  assert.deepEqual(await f.run(DL.prepare(hash, key, context)), {
    status: "ready",
  });
});

test("ambiguous Debrid-Link add is not retried and later invocation reuses account state", async () => {
  let present = false;
  const f = fixture({
    jobs: () => (present ? [job()] : []),
    details: () => job({ status: 1, downloadPercent: 0, files: [] }),
    add: async () => {
      present = true;
      throw Error("synthetic disconnect");
    },
  });
  await assert.rejects(
    f.run(DL.prepare(hash, key, context)),
    /outcome is uncertain/,
  );
  assert.deepEqual(await f.run(DL.prepare(hash, key, context)), {
    status: "preparing",
  });
  assert.equal(writes(f.calls).length, 1);
});

test("Debrid-Link process gate prevents parallel adds and releases after cancellation", async () => {
  let entered!: () => void,
    present = false;
  const active = new Promise<void>((resolve) => (entered = resolve));
  const f = fixture({
    jobs: () => (present ? [job()] : []),
    details: () => job({ files: [], downloadPercent: 0 }),
    add: async () => {
      present = true;
      entered();
      return new Promise(() => {});
    },
  });
  const controller = new AbortController(),
    first = f.run(DL.prepare(hash, key, context), controller.signal);
  await active;
  await assert.rejects(
    f.run(DL.prepare(hash, key, context)),
    /preparation is in progress/,
  );
  controller.abort();
  await assert.rejects(first);
  assert.deepEqual(await f.run(DL.prepare(hash, key, context)), {
    status: "preparing",
  });
  assert.equal(writes(f.calls).length, 1);
});

test("Debrid-Link classifies official auth and quota errors without exposing raw bodies", async () => {
  for (const [error, kind] of [
    ["badToken", "unauthorized"],
    ["maxTorrent", "throttled"],
  ]) {
    const f = fixture();
    f.host.fetch = async () =>
      Response.json({ success: false, error, detail: key });
    await assert.rejects(f.run(DL.verify(key)), (e) => {
      assert(e instanceof Error && "kind" in e);
      assert.equal(e.kind, kind);
      assert(!e.message.includes(key));
      return true;
    });
    assert.deepEqual(f.logs, []);
  }
});
