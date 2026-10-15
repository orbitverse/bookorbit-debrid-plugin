import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  config,
  Selection,
  fail,
  type PluginReleaseQuery,
  type PluginReleaseCandidate,
  type File,
} from "./model.js";
import type { PluginIndexerConfig } from "../vendor/bookorbit-plugin-api.js";
import { Network, decode } from "./http.js";
import { searchFeed } from "./torznab.js";
import * as TorBox from "./torbox.js";
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
  const { account, endpoints } = yield* prepare(cfg);
  const host = yield* Network;
  const outcomes = yield* Effect.forEach(
    endpoints,
    (endpoint) =>
      searchFeed(endpoint, account.indexerKey, q).pipe(Effect.result),
    { concurrency: 4 },
  );
  const successful = outcomes.filter(Result.isSuccess);
  if (!successful.length)
    return yield* Effect.fail(outcomes.find(Result.isFailure)!.failure);
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
  if (!torrents.size) return [];
  const available = yield* TorBox.cached(
    [...torrents.keys()],
    account.debrid.key,
  );
  const releases: PluginReleaseCandidate[] = [];
  for (const item of available) {
    const t = torrents.get(item.hash)!;
    for (const selected of selectFiles(item.files, q)) {
      const value: Selection = {
        provider: "torbox",
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
        title: `${t.title} · ${selected.format.toUpperCase()} · ${t.indexer} · TorBox`,
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
  return releases.slice(0, Math.max(1, Math.min(q.limit, 100)));
});

export const resolveFile = Effect.fnUntraced(function* (
  release: PluginReleaseCandidate,
  cfg: PluginIndexerConfig,
) {
  const { account } = yield* prepare(cfg);
  const raw = yield* Effect.try({
    try: (): unknown => JSON.parse(release.guid),
    catch: () => fail("Invalid release identifier. Search again."),
  });
  const selection = yield* decode(Selection, raw, "Release");
  const cached = yield* TorBox.cached([selection.hash], account.debrid.key);
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
  const url = yield* TorBox.resolve(
    { ...selection, files },
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
  const { account } = yield* prepare(cfg);
  yield* TorBox.cached([], account.debrid.key);
  const q: PluginReleaseQuery = {
    title: "Pride and Prejudice",
    author: "Jane Austen",
    isbn13: null,
    isbn13s: [],
    mediaKind: "ebook",
    language: "en",
    limit: 1,
  };
  const releases = yield* search(q, cfg);
  return {
    success: true,
    indexerName: `BookOrbit Debrid: indexer search and TorBox cache access verified; ${releases.length} matching cached releases`,
  };
});
