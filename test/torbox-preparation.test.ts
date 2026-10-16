import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as TorBox from "../src/torbox.js";
import { Network } from "../src/http.js";
import type { SourceError } from "../src/model.js";
import type { PluginHost } from "../vendor/bookorbit-plugin-api.js";

const hash = "a".repeat(40),
  other = "b".repeat(40),
  key = "SYNTHETIC_PREPARATION_KEY";
const file = { id: 0, name: "Book.epub", size: 123, infected: false };
const job = (changes = {}) => ({
  id: 7,
  hash,
  name: "Book",
  download_state: "downloading",
  download_finished: false,
  download_present: false,
  files: [],
  ...changes,
});
const readyJob = () =>
  job({
    download_state: "completed",
    download_finished: true,
    download_present: true,
    files: [file],
  });
const envelope = (data: unknown) =>
  Response.json({ success: true, error: null, data });
let fixtureId = 0;
function fixture(
  jobs: () => unknown[],
  create?: () => Promise<Response>,
  identity: { key?: string; hash?: string } = {},
) {
  const accountKey = identity.key ?? `${key}_${++fixtureId}`,
    requestedHash = identity.hash ?? hash;
  const calls: string[] = [],
    logs: string[] = [];
  const host: PluginHost = {
    async fetch(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, "https://api.torbox.app");
      assert.equal(init?.headers?.Authorization, `Bearer ${accountKey}`);
      assert.equal(init?.redirect, "manual");
      calls.push(url.pathname);
      if (url.pathname.endsWith("mylist")) {
        assert.equal(url.searchParams.get("bypass_cache"), "true");
        assert.equal(url.searchParams.get("limit"), "1000");
        return envelope(jobs());
      }
      if (url.pathname.endsWith("checkcached")) return envelope({});
      if (url.pathname.endsWith("createtorrent")) {
        assert.match(init!.body!, /name="add_only_if_cached"\r\n\r\nfalse/);
        assert.match(init!.body!, new RegExp(requestedHash));
        assert(!init!.body!.includes(accountKey));
        return create
          ? create()
          : envelope({ hash: requestedHash, torrent_id: 7 });
      }
      assert(url.pathname.endsWith("requestdl"));
      assert.equal(url.searchParams.get("torrent_id"), "7");
      return envelope("https://cdn.example/book.epub?ticket=opaque");
    },
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
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
  return { calls, logs, run, host, key: accountKey };
}

test("absent TorBox job is prepared once without returning a download URL", async () => {
  const f = fixture(() => [job({ hash: other })]);
  assert.deepEqual(await f.run(TorBox.prepare(hash, f.key)), {
    status: "preparing",
  });
  assert.deepEqual(
    f.calls.map((path) => path.split("/").pop()),
    ["mylist", "createtorrent"],
  );
  assert.deepEqual(f.logs, []);
});

test("existing pending and ready TorBox jobs are reused without a mutation", async () => {
  for (const [existing, expected] of [
    [job(), "preparing"],
    [readyJob(), "ready"],
    [job({ download_state: "new-status" }), "preparing"],
  ] as const) {
    const f = fixture(() => [existing]);
    assert.deepEqual(await f.run(TorBox.prepare(hash, f.key)), {
      status: expected,
    });
    assert.equal(f.calls.length, 1);
  }
});

test("terminal and infected TorBox jobs are not restarted", async () => {
  for (const existing of [
    job({ download_state: "error" }),
    job({ download_state: "missingFiles" }),
    job({ files: [{ ...file, infected: true }] }),
  ]) {
    const f = fixture(() => [existing]);
    await assert.rejects(f.run(TorBox.prepare(hash, f.key)), /not restarted/);
    assert.equal(f.calls.length, 1);
  }
});

test("ambiguous add is not retried and later entry is reconciled through account state", async () => {
  let jobs: unknown[] = [];
  const f = fixture(
    () => jobs,
    async () => {
      jobs = [job()];
      throw Error("synthetic disconnect");
    },
  );
  await assert.rejects(
    f.run(TorBox.prepare(hash, f.key)),
    /outcome is uncertain/,
  );
  assert.deepEqual(await f.run(TorBox.prepare(hash, f.key)), {
    status: "preparing",
  });
  assert.equal(
    f.calls.filter((path) => path.endsWith("createtorrent")).length,
    1,
  );
});

test("preparation does not add against malformed or truncated account inventory", async () => {
  for (const jobs of [
    [{ hash }],
    Array.from({ length: 1000 }, (_, id) => job({ id, hash: other })),
  ]) {
    const f = fixture(() => jobs);
    await assert.rejects(f.run(TorBox.prepare(hash, f.key)));
    assert(!f.calls.some((path) => path.endsWith("createtorrent")));
  }
});

test("parallel preparations never issue two mutations in the same loaded module", async () => {
  let release!: () => void, entered!: () => void;
  const active = new Promise<void>((resolve) => (entered = resolve)),
    wait = new Promise<void>((resolve) => (release = resolve));
  const f = fixture(
    () => [],
    async () => {
      entered();
      await wait;
      return envelope({ hash, torrent_id: 7 });
    },
  );
  const first = f.run(TorBox.prepare(hash, f.key));
  await active;
  await assert.rejects(
    f.run(TorBox.prepare(hash, f.key)),
    /preparation is in progress/,
  );
  release();
  assert.deepEqual(await first, { status: "preparing" });
  assert.equal(
    f.calls.filter((path) => path.endsWith("createtorrent")).length,
    1,
  );
});

test("cancelling an accepted add releases the local gate and later reuses provider state", async () => {
  let jobs: unknown[] = [],
    entered!: () => void;
  const active = new Promise<void>((resolve) => (entered = resolve));
  const f = fixture(
    () => jobs,
    async () => {
      jobs = [job()];
      entered();
      return new Promise(() => {});
    },
  );
  const controller = new AbortController();
  const attempt = f.run(TorBox.prepare(hash, f.key), controller.signal);
  await active;
  controller.abort();
  await assert.rejects(attempt);
  assert.deepEqual(await f.run(TorBox.prepare(hash, f.key)), {
    status: "preparing",
  });
  assert.equal(
    f.calls.filter((path) => path.endsWith("createtorrent")).length,
    1,
  );
});

test("ready account files supplement cache misses without exposing pending or unsafe manifests", async () => {
  const f = fixture(() => [
    readyJob(),
    job({ hash: other }),
    job({
      hash: "c".repeat(40),
      files: [{ ...file, infected: true }],
      download_finished: true,
      download_present: true,
    }),
  ]);
  assert.deepEqual(
    await f.run(TorBox.available([hash, other, "c".repeat(40)], f.key)),
    [{ hash, name: "Book", files: [file] }],
  );
  assert(
    !f.calls.some(
      (path) => path.endsWith("createtorrent") || path.endsWith("requestdl"),
    ),
  );
});

test("an opted-in ready account release resolves without another cache-only add", async () => {
  const f = fixture(() => [readyJob()]);
  const url = await f.run(
    TorBox.resolve(
      {
        provider: "torbox",
        hash,
        title: "Book",
        media: "ebook",
        fingerprint: "d".repeat(64),
        format: "epub",
        files: [file],
        reuseAccount: true,
      },
      f.key,
    ),
  );
  assert.equal(url, "https://cdn.example/book.epub?ticket=opaque");
  assert.deepEqual(
    f.calls.map((path) => path.split("/").pop()),
    ["mylist", "requestdl"],
  );
});

test("an accepted but invisible preparation is not added again, while visible state stays authoritative", async () => {
  let jobs: unknown[] = [];
  const f = fixture(() => jobs);
  assert.deepEqual(await f.run(TorBox.prepare(hash, f.key)), {
    status: "preparing",
  });
  await assert.rejects(f.run(TorBox.prepare(hash, f.key)), (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /Wait at least ten minutes/);
    assert(!error.message.includes(f.key));
    assert(!error.message.includes(hash));
    return true;
  });
  jobs = [readyJob()];
  assert.deepEqual(await f.run(TorBox.prepare(hash, f.key)), {
    status: "ready",
  });
  assert.equal(
    f.calls.filter((path) => path.endsWith("createtorrent")).length,
    1,
  );
  assert.deepEqual(f.logs, []);
});

test("an ambiguous invisible preparation remains guarded after its local gate is released", async () => {
  const f = fixture(
    () => [],
    async () => {
      throw Error("synthetic disconnect");
    },
  );
  await assert.rejects(
    f.run(TorBox.prepare(hash, f.key)),
    /outcome is uncertain/,
  );
  await assert.rejects(
    f.run(TorBox.prepare(hash, f.key)),
    /Wait at least ten minutes/,
  );
  assert.equal(
    f.calls.filter((path) => path.endsWith("createtorrent")).length,
    1,
  );
});

test("preparation visibility guards isolate accounts and exact hashes", async () => {
  const f = fixture(() => []),
    otherAccount = fixture(() => []);
  const otherTorrent = fixture(() => [], undefined, {
    key: f.key,
    hash: other,
  });
  for (const [current, selectedHash] of [
    [f, hash],
    [otherAccount, hash],
    [otherTorrent, other],
  ] as const) {
    assert.deepEqual(
      await current.run(TorBox.prepare(selectedHash, current.key)),
      { status: "preparing" },
    );
    assert.equal(
      current.calls.filter((path) => path.endsWith("createtorrent")).length,
      1,
    );
  }
});

test("visibility attempts expire after ten minutes and the bound never evicts active attempts", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime((yield* Clock.currentTimeMillis) + 3_600_000);
        yield* Effect.promise(async () => {
          const run = (f: ReturnType<typeof fixture>) =>
            f.run(
              TorBox.prepare(hash, f.key).pipe(
                Effect.provideService(Clock.Clock, clock),
              ),
            );
          const first = fixture(() => []);
          await run(first);
          await Effect.runPromise(clock.adjust("599999 millis"));
          await assert.rejects(run(first), /Wait at least ten minutes/);
          await Effect.runPromise(clock.adjust("1 milli"));
          await run(first);
          assert.equal(
            first.calls.filter((path) => path.endsWith("createtorrent")).length,
            2,
          );
          for (let i = 1; i < 100; i++) await run(fixture(() => []));
          const blocked = fixture(() => []);
          await assert.rejects(
            run(blocked),
            /Too many recent TorBox preparations/,
          );
          assert(!blocked.calls.some((path) => path.endsWith("createtorrent")));
          await assert.rejects(run(first), /Wait at least ten minutes/);
          await Effect.runPromise(clock.adjust("10 minutes"));
          await run(blocked);
          assert.equal(
            blocked.calls.filter((path) => path.endsWith("createtorrent"))
              .length,
            1,
          );
        });
      }),
    ),
  );
});
