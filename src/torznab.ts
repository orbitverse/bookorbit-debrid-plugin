import { load } from "cheerio/slim";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fail, type PluginReleaseQuery } from "./model.js";
import { decode, json, request } from "./http.js";

interface Category {
  readonly id: number;
  readonly subCategories?: readonly Category[];
}
const Category = Schema.Struct({
  id: Schema.Int,
  subCategories: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category)),
  ),
});
const Indexer = Schema.Struct({
  id: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  enable: Schema.Boolean,
  supportsSearch: Schema.optionalKey(Schema.Boolean),
  protocol: Schema.optionalKey(Schema.String),
  privacy: Schema.optionalKey(Schema.String),
  capabilities: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        categories: Schema.Array(Category),
      }),
    ),
  ),
});

export const discover = Effect.fnUntraced(function* (
  baseUrl: string,
  key: string,
  mediaKinds: readonly PluginReleaseQuery["mediaKind"][],
) {
  const base = baseUrl.replace(/\/+$/, "") + "/";
  const response = yield* request(
    new URL("api/v1/indexer", base).href,
    "Prowlarr",
    {
      headers: { "X-Api-Key": key },
    },
  );
  const indexers = yield* decode(
    Schema.Array(Indexer),
    yield* json(response),
    "Prowlarr indexers",
  );
  const categories = new Set<number>(
    mediaKinds.map((kind) => (kind === "audiobook" ? 3030 : 7020)),
  );
  const supports = (tree: readonly Category[]): boolean =>
    tree.some((c) => categories.has(c.id) || supports(c.subCategories ?? []));
  const ids = [
    ...new Set(
      indexers
        .filter(
          (i) =>
            i.enable &&
            i.supportsSearch === true &&
            i.protocol === "torrent" &&
            i.privacy === "public" &&
            supports(i.capabilities?.categories ?? []),
        )
        .map((i) => i.id),
    ),
  ];
  if (!ids.length)
    return yield* Effect.fail(
      fail(
        `No enabled public ${mediaKinds.length === 1 ? mediaKinds[0] : "ebook or audiobook"} indexers found in Prowlarr. Add one with the matching category, or enter Torznab API paths for another server.`,
      ),
    );
  if (ids.length > 8)
    return yield* Effect.fail(
      fail(
        "More than eight matching public indexers found. Choose up to eight using Torznab API paths.",
      ),
    );
  return ids.map((id) => new URL(`${id}/api`, base).href);
});

type Torrent = {
  hash: string;
  title: string;
  author?: string;
  language?: string;
  indexer: string;
};
export const searchFeed = Effect.fnUntraced(function* (
  endpoint: string,
  key: string,
  q: PluginReleaseQuery,
) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    t: "search",
    apikey: key,
    q: [q.title, q.author].filter(Boolean).join(" "),
    cat: q.mediaKind === "audiobook" ? "3030" : "7020",
    extended: "1",
    limit: "50",
  }).toString();
  const response = yield* request(url.href, "Torznab");
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => fail("Could not read Torznab results."),
  });
  return yield* Effect.try({
    try: () => {
      const $ = load(body, { xmlMode: true });
      if ($("error").length)
        throw fail(
          "Torznab rejected the search. Check the API key and indexer settings.",
        );
      if (!$("rss > channel").length)
        throw fail(
          "Not a Torznab feed. Use an indexer's API path, not the web interface.",
        );
      const indexer =
        $("channel > title").first().text().trim().slice(0, 100) || "Torznab";
      const results: Torrent[] = [];
      $("item")
        .slice(0, 50)
        .each((_, node) => {
          const item = $(node);
          const attr = (name: string) =>
            item
              .find("torznab\\:attr, newznab\\:attr")
              .filter((_, el) => $(el).attr("name") === name)
              .first()
              .attr("value");
          const privateTracker =
            attr("private") ?? item.find("indexer").attr("type");
          if (["1", "true", "private"].includes(privateTracker ?? "")) return;
          let hash = attr("infohash")?.toLowerCase();
          if (!hash) {
            const magnet =
              attr("magneturl") ??
              item.find("enclosure").attr("url") ??
              item.find("link").text();
            if (magnet.startsWith("magnet:?"))
              hash = new URL(magnet).searchParams
                .getAll("xt")
                .map((s) =>
                  s.match(/^urn:btih:([a-f0-9]{40})$/i)?.[1].toLowerCase(),
                )
                .find(Boolean);
          }
          const title = item.find("title").first().text().trim().slice(0, 500);
          if (hash && /^[a-f0-9]{40}$/.test(hash) && title)
            results.push({
              hash,
              title,
              author: attr("author"),
              language: attr("language"),
              indexer,
            });
        });
      return results;
    },
    catch: (error) =>
      error instanceof Error && "kind" in error
        ? (error as ReturnType<typeof fail>)
        : fail("Could not parse Torznab results."),
  });
});
