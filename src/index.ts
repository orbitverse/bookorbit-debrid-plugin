import packageInfo from "../package.json" with { type: "json" };
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { Network } from "./http.js";
import { SourceError, fail, type PluginHost } from "./model.js";
import type { IndexerPlugin } from "../vendor/bookorbit-plugin-api.js";
import * as Library from "./library.js";

const run = async <A>(
  effect: Effect.Effect<A, SourceError, Network>,
  host: PluginHost,
  signal?: AbortSignal,
): Promise<A> => {
  const result = await Effect.runPromiseExit(
    effect.pipe(
      Effect.provideService(Network, host),
      Effect.timeoutOrElse({
        duration: "18 seconds",
        orElse: () =>
          Effect.fail(
            fail("Request timed out. Retry with fewer indexers.", "timeout"),
          ),
      }),
    ),
    { signal },
  );
  if (Exit.isSuccess(result)) return result.value;
  if (signal?.aborted)
    throw host.fail("timeout", "Request cancelled or timed out.");
  const error = Cause.squash(result.cause);
  throw error instanceof SourceError
    ? host.fail(error.kind, error.message)
    : host.fail(
        "error",
        "Unexpected source response. Check the configuration or update the plugin.",
      );
};

export default {
  apiVersion: 1,
  version: packageInfo.version,
  type: "bookorbit-debrid-plugin",
  label: "BookOrbit Debrid",
  requiresCredential: true,
  credentialKind: "apiKey",
  mediaKinds: ["ebook", "audiobook"],
  supportsIsbnSearch: false,
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: "http://prowlarr:9696",
  baseUrlHint:
    "Your Prowlarr or Jackett server address. For a local server, enable Allow private addresses. Paste the account JSON from the README into API key.",
  settingsFields: [
    {
      key: "prepareUncached",
      type: "boolean",
      label: "Show uncached torrents",
      default: false,
      hint: "TorBox only. Results marked Prepare need an availability check. View files or Download may start preparation in your account; search again later to download. Automatic grabs can also start preparation. This uses your provider allowance; BookOrbit cannot finish it automatically.",
    },
    {
      key: "indexerPaths",
      type: "string",
      label: "Torznab API paths",
      default: "",
      hint: "Leave blank to find public book indexers in Prowlarr automatically. For Jackett or a custom selection, enter paths such as /1/api,/2/api without query strings.",
    },
  ],
  search: (q, cfg, host, signal) => run(Library.search(q, cfg), host, signal),
  resolveFile: (release, cfg, host, signal) =>
    run(Library.resolveFile(release, cfg), host, signal),
  async test(cfg, host) {
    try {
      return await run(Library.test(cfg), host);
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Connection test failed.",
      };
    }
  },
} satisfies IndexerPlugin;
