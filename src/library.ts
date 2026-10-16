import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
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
  const searchIndexer = searchFeeds(account.indexerKey, q);
  type Outcome = Result.Result<
    Effect.Success<ReturnType<typeof searchIndexer>>,
    ReturnType<typeof fail>
  >;
  const collected: (Outcome | undefined)[] = [];
  let collectionExpired = false;
  const collectionTimeout = () =>
    fail(
      "Indexer search timed out before all feeds completed. Retry with fewer indexers.",
      "timeout",
    );
  // Discovery, feed requests and metadata share one stage budget, leaving time for cache access.
  yield* Effect.gen(function* () {
    const endpoints = configured.length
      ? configured
      : yield* discover(baseUrl, account.indexerKey, [q.mediaKind]);
    yield* Effect.forEach(
      endpoints,
      (endpoint, index) =>
        searchIndexer(endpoint).pipe(
          Effect.result,
          Effect.map((outcome) => {
            collected[index] = outcome;
          }),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: "12 seconds",
      orElse: () =>
        Effect.sync(() => {
          collectionExpired = true;
          host.logger.warn(collectionTimeout().message);
        }),
    }),
  );
  const outcomes = collected.filter((outcome) => outcome !== undefined);
  const successful = outcomes.filter(Result.isSuccess);
  const firstFailure = outcomes.find(Result.isFailure)?.failure;
  if (!successful.length)
    return yield* Effect.fail(firstFailure ?? collectionTimeout());
  for (const outcome of outcomes)
    if (Result.isFailure(outcome)) host.logger.warn(outcome.failure.message);
  const torrents = new Map<
    string,
    (typeof successful)[number]["success"][number]
  >();
  // Interleave feeds before applying the cache-check ceiling.
  for (let i = 0; i < 50; i++)
    for (const outcome of successful) {
      const t = outcome.success[i];
      if (
        t &&
        matches(q.title, t.title) &&
        (!q.author || !t.author || matches(q.author, t.author)) &&
        (!q.language ||
          !t.language ||
          q.language.toLowerCase() === t.language.toLowerCase()) &&
        torrents.size < 100
      )
        torrents.set(t.hash, t);
    }
  if (!torrents.size) {
    if (firstFailure || collectionExpired)
      return yield* Effect.fail(firstFailure ?? collectionTimeout());
    return [];
  }
  const available = yield* (
    prepareUncached && service.available ? service.available : service.cached
  )([...torrents.keys()], account.debrid.key);
  const releases: PluginReleaseCandidate[] = [];
  for (const item of available) {
    const t = torrents.get(item.hash)!;
    for (const selected of selectFiles(item.files, q)) {
      if (selected.format === "zip" && !service.supportsZip) continue;
      const value: Selection = {
        provider: account.debrid.provider,
        hash: item.hash,
        title: q.title,
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
        bookTitle: q.title,
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
        title: q.title,
        media: q.mediaKind,
      } satisfies typeof Preparation.Type);
      if (guid.length > 4000) continue;
      releases.push({
        guid,
        title: `${q.title} · Prepare in ${service.label} (download later) · ${t.indexer}`,
        bookTitle: q.title,
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
  if (!endpoints.length) {
    yield* discover(baseUrl, account.indexerKey, ["ebook", "audiobook"]);
    return {
      success: true,
      indexerName: `BookOrbit Debrid: Prowlarr indexer configuration and ${service.label} account access verified`,
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
    indexerName: `BookOrbit Debrid: indexer search and ${service.label} cache access verified; ${releases.length} matching cached releases`,
  };
});
