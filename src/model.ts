import * as Schema from "effect/Schema";
import type { PluginIndexerConfig } from "../vendor/bookorbit-plugin-api.js";
export type {
  PluginHost,
  PluginRequestInit,
  PluginReleaseQuery,
  PluginReleaseCandidate,
} from "../vendor/bookorbit-plugin-api.js";

export class SourceError extends Schema.TaggedError<SourceError>()(
  "SourceError",
  {
    message: Schema.String,
    kind: Schema.Literals([
      "unauthorized",
      "throttled",
      "timeout",
      "unreachable",
      "error",
    ]),
  },
) {}
export const fail = (message: string, kind: SourceError["kind"] = "error") =>
  new SourceError({ message, kind });
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
export const Size = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const File = Schema.Struct({ name: Schema.NonEmptyString, size: Size });
export type File = typeof File.Type;
export const Selection = Schema.Struct({
  provider: Schema.Literal("torbox"),
  hash: Hash,
  title: Schema.NonEmptyString,
  media: Schema.Literals(["ebook", "audiobook"]),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  format: Schema.NonEmptyString,
});
export type Selection = typeof Selection.Type;

const Account = Schema.Struct({
  indexerKey: Schema.NonEmptyString,
  debrid: Schema.Struct({
    provider: Schema.Literal("torbox"),
    key: Schema.NonEmptyString,
  }),
});
export const config = (cfg: PluginIndexerConfig) => {
  let account: typeof Account.Type;
  try {
    account = Schema.decodeUnknownSync(Account, { onExcessProperty: "error" })(
      JSON.parse(cfg.credential ?? ""),
    );
    if (!account.indexerKey.trim() || !account.debrid.key.trim()) throw Error();
  } catch {
    throw fail(
      'Paste account JSON with indexerKey and debrid: { provider: "torbox", key: "..." } into API key.',
      "unauthorized",
    );
  }
  let base: URL;
  try {
    base = new URL(cfg.baseUrl);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw Error();
  } catch {
    throw fail(
      "Use your Prowlarr or Jackett HTTP(S) address without credentials or a query.",
    );
  }
  const raw = cfg.settings?.indexerPaths ?? "/1/api";
  if (typeof raw !== "string")
    throw fail("Indexer paths must be a comma-separated list.");
  const paths = [
    ...new Set(
      raw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
  if (!paths.length || paths.length > 8)
    throw fail("Choose between one and eight Torznab API paths.");
  const endpoints = paths.map((path) => {
    const url = new URL(path, base);
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      url.origin !== base.origin ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw fail(
        "Indexer paths must stay on the configured server and contain no query or credentials.",
      );
    return url.href;
  });
  return { account, endpoints };
};
