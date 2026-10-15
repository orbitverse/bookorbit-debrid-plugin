import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  fail,
  SourceError,
  type PluginHost,
  type PluginRequestInit,
} from "./model.js";

export class Network extends Context.Service<Network, PluginHost>()(
  "bookorbit-debrid/Network",
) {}

export const request = Effect.fnUntraced(function* (
  url: string,
  label: string,
  init: PluginRequestInit = {},
  retry = true,
) {
  const host = yield* Network;
  const attempt = Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => host.fetch(url, { ...init, redirect: "manual" }),
      catch: () =>
        fail(
          `${label}: could not connect. Check the address and network access.`,
          "unreachable",
        ),
    });
    if (!response.ok) {
      yield* Effect.tryPromise({
        try: async () => {
          await response.body?.cancel();
        },
        catch: () => fail("Could not release response."),
      }).pipe(Effect.ignore);
      return yield* Effect.fail(
        fail(
          response.status === 401 || response.status === 403
            ? `${label}: access denied. Check the API key.`
            : `${label}: HTTP ${response.status}. Retry later.`,
          response.status === 401 || response.status === 403
            ? "unauthorized"
            : response.status === 429
              ? "throttled"
              : "error",
        ),
      );
    }
    return response;
  });
  return yield* (
    retry
      ? attempt.pipe(
          Effect.retry(
            Schedule.recurs(1).pipe(
              Schedule.addDelay(() => Effect.succeed("250 millis")),
              Schedule.while(
                ({ input }: { input: SourceError }) =>
                  input.kind === "unreachable",
              ),
            ),
          ),
        )
      : attempt
  ).pipe(
    Effect.timeoutOrElse({
      duration: "4 seconds",
      orElse: () =>
        Effect.fail(fail(`${label}: request timed out.`, "timeout")),
    }),
  );
});
export const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  label: string,
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: () =>
      fail(`${label}: response was not recognized. Try updating the plugin.`),
  });
export const json = Effect.fnUntraced(function* (response: Response) {
  return yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: () => fail("Server returned invalid JSON."),
  });
});
