import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  config,
  Preparation,
  Release,
  type Selection,
  fail,
  type PluginReleaseQuery,
  type PluginReleaseCandidate,
  type File,
} from "./model.js";
import { collect } from "./collect.js";
import type { PluginIndexerConfig } from "../vendor/bookorbit-plugin-api.js";
import { Network, decode } from "./http.js";
import { discover, searchFeeds } from "./torznab.js";
import { provider } from "./providers.js";
import { matches, selectFiles, safeFileName } from "./books.js";

const identify = (files: readonly File[]) =>
  Effect.tryPromise({
    try: async () => {
      const canonical = [...files]
        .map((f) => [f.name, f.size])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(canonical)),
        ),
      ).toString("hex");
    },
    catch: () => fail("Could not identify the selected file list."),
  });

const prepare = (cfg: PluginIndexerConfig) =>
  Effect.try({
    try: () => config(cfg),
    catch: (error) =>
      error instanceof Error && "kind" in error
        ? (error as ReturnType<typeof fail>)
        : fail("Invalid source configuration."),
  });

export const search = Effect.fnUntraced(function* (
  q: PluginReleaseQuery,
  cfg: PluginIndexerConfig,
) {
  const {
    account,
    endpoints: configured,
    baseUrl,
    prepareUncached,
  } = yield* prepare(cfg);
  const service = provider(account.debrid.provider);
  const host = yield* Network;
  const title = host.buildSearchText({ ...q, author: null });
  const searchIndexer = searchFeeds(account.indexerKey, q);
  const started = yield* Clock.currentTimeMillis;
  const endpoints = configured.length
    ? configured
    : yield* discover(baseUrl, account.indexerKey, [q.mediaKind]);
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  // Discovery, feed requests and metadata share one stage. It ends early enough to leave time for
  // cache access once a feed has matches, and waits longer only while there is nothing to check.
  const relevant = (t: { readonly title: string }) => matches(title, t.title);
  const feeds = (yield* collect(endpoints, searchIndexer, {
    softMs: Math.max(0, 12000 - elapsed),
    hardMs: Math.max(0, 16000 - elapsed),
    matches: relevant,
  })).map((feed, index) => ({
    ...feed,
    // A feed is named by its path only: never a query string or key.
    path: new URL(endpoints[index]).pathname,
  }));
  const paths = (named: typeof feeds) =>
    named.map((feed) => feed.path).join(", ");
  const unanswered = feeds.filter((feed) => feed.stage === "waiting");
  const checking = feeds.filter((feed) => feed.stage === "answered");
  const stillChecking = `${paths(checking)} ${checking.length === 1 ? "was" : "were"} still checking torrent links`;
  const retry = "Retry shortly; the first search after a restart can be slow.";
  const waiting = `Indexer search timed out waiting for ${paths(unanswered)}. ${retry}`;
  const failures = feeds.flatMap((feed) =>
    feed.failure
      ? [fail(`${feed.path}: ${feed.failure.message}`, feed.failure.kind)]
      : [],
  );
  // What the search fails with when the feeds that finished leave nothing to check.
  const problem =
    failures[0] ??
    (unanswered.length
      ? fail(waiting, "timeout")
      : checking.length
        ? fail(
            `Indexer search timed out while ${stillChecking}. ${retry}`,
            "timeout",
          )
        : undefined);
  /** Names every feed that did not finish or failed, once; `error` is what the search fails with. */
  const report = (error?: ReturnType<typeof fail>) => {
    if (unanswered.length) host.logger.warn(waiting);
    for (const failure of failures)
      if (failure !== error) host.logger.warn(failure.message);
    // The same feeds are not named twice when their sentence is the error itself.
    if (checking.length && !(error && !failures.length && !unanswered.length))
      host.logger.warn(
        `Indexer search stopped while ${stillChecking}${error ? "" : "; matches already identified remain available"}.`,
      );
  };
  const stop = (error: ReturnType<typeof fail>) => {
    report(error);
    return Effect.fail(error);
  };
  const torrents = new Map<string, (typeof feeds)[number]["known"][number]>();
  // Feeds that finished come first, interleaved before the cache-check ceiling applies. What
  // unfinished feeds already knew follows, so it never displaces or reorders a finished feed's.
  let fromFinished = 0;
  for (const finished of [true, false]) {
    for (let i = 0; i < 50; i++)
      for (const feed of feeds) {
        const t = feed.known[i];
        if ((feed.stage === "finished") !== finished || !t || !relevant(t))
          continue;
        if (torrents.size < 100 && (finished || !torrents.has(t.hash)))
          torrents.set(t.hash, t);
      }
    if (finished) fromFinished = torrents.size;
  }
  if (!torrents.size) return problem ? yield* stop(problem) : [];
  // With matches only from feeds that had not finished, collection ran to its last moment. The
  // cache then gets what is left of the search, and the feeds' own problem is the answer if the
  // cache has nothing in that time.
  const rescue = fromFinished ? undefined : problem;
  if (!rescue) report();
  const check = (
    prepareUncached && service.available ? service.available : service.cached
  )([...torrents.keys()], account.debrid.key);
  const available = rescue
    ? yield* check.pipe(
        Effect.timeoutOrElse({
          duration: Math.max(
            0,
            17750 - ((yield* Clock.currentTimeMillis) - started),
          ),
          orElse: () => Effect.fail(rescue),
        }),
        Effect.catch(() => stop(rescue)),
      )
    : yield* check;
  const releases: PluginReleaseCandidate[] = [];
  for (const item of available) {
    const t = torrents.get(item.hash)!;
    for (const selected of selectFiles(item.files, { ...q, title })) {
      if (selected.format === "zip" && !service.supportsZip) continue;
      const value: Selection = {
        provider: account.debrid.provider,
        hash: item.hash,
        title,
        media: q.mediaKind,
        format: selected.format,
        fingerprint: yield* identify(selected.files),
      };
      const guid = JSON.stringify(value);
      // BookOrbit caps release identifiers at 4,000 characters.
      if (guid.length > 4000) continue;
      const sizeBytes = selected.files.reduce((sum, f) => sum + f.size, 0);
      if (sizeBytes > 8 * 1024 ** 3) continue;
      releases.push({
        guid,
        title: `${t.title} · ${selected.format.toUpperCase()} · ${t.indexer} · ${service.label}`,
        author: t.author,
        language: t.language,
        format: selected.format,
        sizeBytes,
        seeders: null,
        leechers: null,
        primaryFileCount: selected.format === "zip" ? 1 : selected.files.length,
      });
    }
  }
  if (!releases.length && prepareUncached && service.prepare) {
    const ready = new Set(available.map((item) => item.hash));
    for (const t of torrents.values()) {
      if (ready.has(t.hash)) continue;
      const guid = JSON.stringify({
        action: "prepare",
        provider: account.debrid.provider,
        hash: t.hash,
        title,
        media: q.mediaKind,
      } satisfies typeof Preparation.Type);
      if (guid.length > 4000) continue;
      releases.push({
        guid,
        title: `${t.title} · Prepare in ${service.label} (download later) · ${t.indexer}`,
        author: t.author,
        language: t.language,
        sizeBytes: null,
        seeders: null,
        leechers: null,
      });
      // A failed automatic grab may try the next result: offer at most one preparation.
      break;
    }
  }
  if (rescue) {
    if (!releases.length) return yield* stop(rescue);
    report();
  }
  return releases.slice(0, Math.max(1, Math.min(q.limit, 100)));
});

export const resolveFile = Effect.fnUntraced(function* (
  release: PluginReleaseCandidate,
  cfg: PluginIndexerConfig,
) {
  const { account, prepareUncached } = yield* prepare(cfg);
  const service = provider(account.debrid.provider);
  const raw = yield* Effect.try({
    try: (): unknown => JSON.parse(release.guid),
    catch: () => fail("Invalid release identifier. Search again."),
  });
  const selection = yield* decode(Release, raw, "Release");
  if (selection.provider !== account.debrid.provider)
    return yield* Effect.fail(
      fail("The debrid provider changed. Search again."),
    );
  if ("action" in selection) {
    if (!prepareUncached || !service.prepare)
      return yield* Effect.fail(
        fail(
          "Enable Show uncached downloads and search again to prepare this release.",
        ),
      );
    const result = yield* service.prepare(selection.hash, account.debrid.key, {
      title: selection.title,
      mediaKind: selection.media,
    });
    return yield* Effect.fail(
      fail(
        result.status === "ready"
          ? "This release is ready in your debrid account. Search again to select a verified file and download it."
          : "Preparing this release in your debrid account. BookOrbit may show this as an error. Search again later to download; this request will not continue automatically.",
      ),
    );
  }
  if (selection.format === "zip" && !service.supportsZip)
    return yield* Effect.fail(
      fail(
        "This provider cannot deliver a complete track archive. Choose a single-file audiobook.",
      ),
    );
  const cached = yield* (
    prepareUncached && service.available ? service.available : service.cached
  )([selection.hash], account.debrid.key);
  const current = cached.find((item) => item.hash === selection.hash);
  if (!current)
    return yield* Effect.fail(
      fail(
        "This release left the cache. Search again; no download was queued.",
      ),
    );
  const planned = selectFiles(current.files, {
    title: selection.title,
    mediaKind: selection.media,
  });
  let files: readonly File[] | undefined;
  for (const plan of planned)
    if (
      plan.format === selection.format &&
      (yield* identify(plan.files)) === selection.fingerprint
    ) {
      files = plan.files;
      break;
    }
  if (!files)
    return yield* Effect.fail(
      fail(
        "This release changed or is not a complete supported book. Search again; no download was queued.",
      ),
    );
  const url = yield* service.resolve(
    { ...selection, files, reuseAccount: prepareUncached },
    account.debrid.key,
  );
  return {
    url,
    fileName: safeFileName(selection.title, selection.format),
    format: selection.format,
    sizeBytes: selection.format === "zip" ? null : files[0].size,
  };
});

export const test = Effect.fnUntraced(function* (cfg: PluginIndexerConfig) {
  const { account, endpoints, baseUrl } = yield* prepare(cfg);
  const service = provider(account.debrid.provider);
  yield* service.verify(account.debrid.key);
  // Some labels already end in "account"; the sentences below add their own noun.
  const name = service.label.replace(/ account$/, "");
  if (!endpoints.length) {
    yield* discover(baseUrl, account.indexerKey, ["ebook", "audiobook"]);
    return {
      success: true,
      indexerName: `BookOrbit Debrid: Prowlarr indexer configuration and ${name} account access verified`,
    };
  }
  const q: PluginReleaseQuery = {
    title: "Pride and Prejudice",
    author: "Jane Austen",
    isbn13: null,
    isbn13s: [],
    mediaKind: "ebook",
    language: "en",
    limit: 1,
  };
  const releases = yield* search(q, {
    ...cfg,
    settings: { ...cfg.settings, prepareUncached: false },
  });
  return {
    success: true,
    indexerName: `BookOrbit Debrid: indexer search and ${name} cache access verified; ${releases.length} matching cached releases`,
  };
});
