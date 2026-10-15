import { load } from "cheerio/slim";
import * as Effect from "effect/Effect";
import { fail, type PluginReleaseQuery } from "./model.js";
import { request } from "./http.js";

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
