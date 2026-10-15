import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as RD from "../src/realdebrid.js";
import { Network } from "../src/http.js";
import type { SourceError } from "../src/model.js";
import type { PluginHost } from "../vendor/bookorbit-plugin-api.js";

const hash = "a".repeat(40),
  other = "b".repeat(40),
  key = "SYNTHETIC/RD+KEY";
const context = { title: "Book", mediaKind: "ebook" as const };
const file = { id: 1, path: "/Book.epub", bytes: 123, selected: 1 };
const torrent = (changes = {}) => ({
  id: "rd1",
  hash,
  filename: "Book",
  status: "downloaded",
  progress: 100,
  files: [file],
  links: ["https://real-debrid.com/d/opaque"],
  ...changes,
});
const selection = {
  hash,
  files: [{ name: "Book.epub", size: 123 }],
  format: "epub",
};
function fixture(
  options: {
    jobs?: () => unknown[];
    details?: (id: string) => unknown;
    add?: () => Promise<Response>;
    select?: () => Promise<Response>;
    unrestricted?: unknown;
    total?: string;
  } = {},
) {
  const calls: { route: string; method: string; body: URLSearchParams }[] = [],
    logs: string[] = [];
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, "https://api.real-debrid.com");
      assert.equal(init?.headers?.Authorization, `Bearer ${key}`);
      assert.equal(init?.redirect, "manual");
      const route = url.pathname.replace("/rest/1.0/", ""),
        body = new URLSearchParams(init?.body);
      calls.push({ route, method: init?.method ?? "GET", body });
      if (route === "torrents") {
        assert.equal(url.search, "?limit=100&page=1");
        return Response.json(options.jobs?.() ?? [torrent()], {
          headers:
            options.total === undefined
              ? {}
              : { "X-Total-Count": options.total },
        });
      }
      if (route.startsWith("torrents/info/"))
        return Response.json(
          (await options.details?.(route.split("/").pop()!)) ?? torrent(),
        );
      if (route === "torrents/addMagnet") {
        assert.equal(body.get("magnet"), `magnet:?xt=urn:btih:${hash}`);
        return (
          options.add?.() ??
          Response.json(
            {
              id: "rd1",
              uri: "https://api.real-debrid.com/rest/1.0/torrents/info/rd1",
            },
            { status: 201 },
          )
        );
      }
      if (route.startsWith("torrents/selectFiles/"))
        return options.select?.() ?? new Response(null, { status: 204 });
      if (route === "unrestrict/link") {
        assert.equal(body.get("link"), "https://real-debrid.com/d/opaque");
        return Response.json(
          options.unrestricted ?? {
            filename: "Book.epub",
            filesize: 123,
            download: "https://cdn.example/book?ticket=opaque",
          },
        );
      }
      assert.equal(route, "user");
      return Response.json({ id: 1, type: "premium", premium: 100 });
    },
    logger: { log: (s) => logs.push(s), warn: (s) => logs.push(s) },
    buildSearchText: (q) => q.title,
    async saveCredential() {
      throw Error("unexpected credential write");
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
  return { run, calls, logs, host };
}
const mutations = (calls: ReturnType<typeof fixture>["calls"]) =>
  calls.filter((c) => c.method === "POST");

test("Real-Debrid search intersects ready account hashes without adding or unrestricting", async () => {
  const f = fixture({
    jobs: () => [torrent(), torrent({ id: "unrelated", hash: other })],
  });
  assert.deepEqual(await f.run(RD.cached([hash], key)), [
    { hash, name: "Book", files: selection.files },
  ]);
  assert.deepEqual(
    f.calls.map((c) => c.route),
    ["torrents", "torrents/info/rd1"],
  );
  assert.deepEqual(mutations(f.calls), []);
  await f.run(RD.verify(key));
  assert.equal(f.calls.at(-1)!.route, "user");
});

test("Real-Debrid rejects truncated inventory and excessive matching detail fanout", async () => {
  for (const options of [
    { total: "101" },
    {
      jobs: () =>
        Array.from({ length: 100 }, (_, i) =>
          torrent({ id: `rd${i}`, hash: other }),
        ),
    },
    {
      jobs: () =>
        Array.from({ length: 9 }, (_, i) => torrent({ id: `rd${i}` })),
    },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(RD.cached([hash], key)));
    await assert.rejects(f.run(RD.prepare(hash, key, context)));
    assert.deepEqual(mutations(f.calls), []);
  }
});

test("Real-Debrid validates detail hash and never mispairs multiple selected files or links", async () => {
  const mismatch = fixture({ details: () => torrent({ hash: other }) });
  await assert.rejects(
    mismatch.run(RD.cached([hash], key)),
    /different torrent/,
  );
  for (const change of [
    { files: [file, { ...file, id: 2, path: "/Other.epub" }] },
    {
      links: ["https://real-debrid.com/d/one", "https://real-debrid.com/d/two"],
    },
    { links: [] },
    { files: [{ ...file, selected: 0 }] },
    { progress: 99 },
    { status: "downloading" },
  ]) {
    const f = fixture({ details: () => torrent(change) });
    assert.deepEqual(await f.run(RD.cached([hash], key)), []);
    assert.deepEqual(mutations(f.calls), []);
  }
});

test("Real-Debrid resolves only the refreshed singleton and matching unrestricted file", async () => {
  const f = fixture();
  assert.equal(
    await f.run(RD.resolve(selection, key)),
    "https://cdn.example/book?ticket=opaque",
  );
  assert.deepEqual(
    mutations(f.calls).map((c) => c.route),
    ["unrestrict/link"],
  );
  for (const unrestricted of [
    {
      filename: "Other.epub",
      filesize: 123,
      download: "https://cdn.example/book",
    },
    {
      filename: "Book.epub",
      filesize: 124,
      download: "https://cdn.example/book",
    },
  ])
    await assert.rejects(
      fixture({ unrestricted }).run(RD.resolve(selection, key)),
      /does not match/,
    );
  const changed = fixture({
    details: () => torrent({ files: [{ ...file, bytes: 124 }] }),
  });
  await assert.rejects(
    changed.run(RD.resolve(selection, key)),
    /changed or is not ready/,
  );
  assert.deepEqual(mutations(changed.calls), []);
});

test("Real-Debrid rejects unsafe handoff links and keeps errors and logs secret-free", async () => {
  for (const download of [
    "http://cdn.example/book",
    "https://127.0.0.1/book",
    "https://[::1]/book",
    "https://user:pass@cdn.example/book",
    "https://api.real-debrid.com/book",
    `https://cdn.example/book?token=${encodeURIComponent(key)}`,
  ]) {
    const f = fixture({
      unrestricted: { filename: "Book.epub", filesize: 123, download },
    });
    await assert.rejects(f.run(RD.resolve(selection, key)), (error) => {
      assert(error instanceof Error);
      assert.match(error.message, /safe direct download/);
      assert(!error.message.includes(key));
      assert(!error.message.includes(download));
      return true;
    });
    assert.deepEqual(f.logs, []);
  }
});

test("absent Real-Debrid preparation adds once and leaves metadata conversion pending", async () => {
  const f = fixture({
    jobs: () => [],
    details: () =>
      torrent({
        status: "magnet_conversion",
        files: [],
        links: [],
        progress: 0,
      }),
  });
  assert.deepEqual(await f.run(RD.prepare(hash, key, context)), {
    status: "preparing",
  });
  assert.deepEqual(
    mutations(f.calls).map((c) => c.route),
    ["torrents/addMagnet"],
  );
});

test("waiting Real-Debrid metadata selects exactly one complete file with no select-all", async () => {
  for (const status of [204, 202]) {
    const f = fixture({
      details: () =>
        torrent({
          status: "waiting_files_selection",
          progress: 0,
          files: [{ ...file, selected: 0 }],
          links: [],
        }),
      select: async () => new Response(null, { status }),
    });
    assert.deepEqual(await f.run(RD.prepare(hash, key, context)), {
      status: "preparing",
    });
    assert.equal(mutations(f.calls).length, 1);
    assert.equal(mutations(f.calls)[0].body.get("files"), "1");
  }
});

test("Real-Debrid refuses ambiguous formats, multipart audio, chapters and unsupported downloaded jobs", async () => {
  for (const [details, q] of [
    [
      torrent({
        status: "waiting_files_selection",
        links: [],
        files: [
          { ...file, selected: 0 },
          { id: 2, path: "/Book.pdf", bytes: 100, selected: 0 },
        ],
      }),
      context,
    ],
    [
      torrent({
        status: "waiting_files_selection",
        links: [],
        files: [1, 2].map((id) => ({
          id,
          path: `/Book/${id}.mp3`,
          bytes: 100,
          selected: 0,
        })),
      }),
      { title: "Book", mediaKind: "audiobook" as const },
    ],
    [
      torrent({ files: [{ ...file, path: "/Book Chapter 1.mp3" }] }),
      { title: "Book", mediaKind: "audiobook" as const },
    ],
    [torrent({ links: [] }), context],
  ] as const) {
    const f = fixture({ details: () => details });
    await assert.rejects(
      f.run(RD.prepare(hash, key, q)),
      /complete|unambiguous/,
    );
    assert.deepEqual(mutations(f.calls), []);
  }
});

test("active and terminal Real-Debrid jobs do not add or reselect", async () => {
  for (const status of [
    "queued",
    "downloading",
    "compressing",
    "waiting_files_selection",
    "future_status",
  ]) {
    const f = fixture({
      details: () => torrent({ status, progress: 0, links: [] }),
    });
    assert.deepEqual(await f.run(RD.prepare(hash, key, context)), {
      status: "preparing",
    });
    assert.deepEqual(mutations(f.calls), []);
  }
  for (const status of ["magnet_error", "error", "virus", "dead"]) {
    const f = fixture({ details: () => torrent({ status }) });
    await assert.rejects(
      f.run(RD.prepare(hash, key, context)),
      /not restarted/,
    );
    assert.deepEqual(mutations(f.calls), []);
  }
});

test("ambiguous Real-Debrid add is not retried and later invocation reuses the account job", async () => {
  let present = false;
  const f = fixture({
    jobs: () => (present ? [torrent()] : []),
    details: () => torrent({ status: "queued", progress: 0, links: [] }),
    add: async () => {
      present = true;
      throw Error("synthetic disconnect");
    },
  });
  await assert.rejects(
    f.run(RD.prepare(hash, key, context)),
    /outcome is uncertain/,
  );
  assert.deepEqual(await f.run(RD.prepare(hash, key, context)), {
    status: "preparing",
  });
  assert.equal(mutations(f.calls).length, 1);
});

test("Real-Debrid preparation gate rejects parallel writes and releases on cancellation", async () => {
  let entered!: () => void,
    present = false;
  const active = new Promise<void>((resolve) => (entered = resolve));
  const f = fixture({
    jobs: () => (present ? [torrent()] : []),
    details: () => torrent({ status: "queued", progress: 0, links: [] }),
    add: async () => {
      present = true;
      entered();
      return new Promise(() => {});
    },
  });
  const controller = new AbortController(),
    first = f.run(RD.prepare(hash, key, context), controller.signal);
  await active;
  await assert.rejects(
    f.run(RD.prepare(hash, key, context)),
    /preparation is in progress/,
  );
  controller.abort();
  await assert.rejects(first);
  assert.deepEqual(await f.run(RD.prepare(hash, key, context)), {
    status: "preparing",
  });
  assert.equal(mutations(f.calls).length, 1);
});

test("Real-Debrid rejects conflicting ready manifests and invalid IDs before remote detail requests", async () => {
  const f = fixture({
    jobs: () => [torrent(), torrent({ id: "rd2" })],
    details: (id) =>
      torrent({
        id,
        files: [{ ...file, path: id === "rd1" ? "/Book.epub" : "/Book.pdf" }],
      }),
  });
  await assert.rejects(f.run(RD.cached([hash], key)), /conflicting/);
  const bad = fixture({ jobs: () => [torrent({ id: "../../user" })] });
  await assert.rejects(bad.run(RD.cached([hash], key)));
  assert.equal(bad.calls.length, 1);
});

test("a newly added Real-Debrid job that is immediately ready still validates the work", async () => {
  const f = fixture({ jobs: () => [] });
  assert.deepEqual(await f.run(RD.prepare(hash, key, context)), {
    status: "ready",
  });
  assert.deepEqual(
    mutations(f.calls).map((c) => c.route),
    ["torrents/addMagnet"],
  );
});

test("ambiguous file selection is not repeated after account selected bits change", async () => {
  let selected = false;
  const f = fixture({
    details: () =>
      torrent({
        status: selected ? "downloading" : "waiting_files_selection",
        progress: 0,
        links: [],
        files: [{ ...file, selected: selected ? 1 : 0 }],
      }),
    select: async () => {
      selected = true;
      throw Error("synthetic selection disconnect");
    },
  });
  await assert.rejects(
    f.run(RD.prepare(hash, key, context)),
    /selection outcome is uncertain/,
  );
  assert.deepEqual(await f.run(RD.prepare(hash, key, context)), {
    status: "preparing",
  });
  assert.equal(mutations(f.calls).length, 1);
});
