import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
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
  limit: Duration.Input = "12 seconds",
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
      duration: limit,
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

// One add per account and hash: a provider module calls its guard only after the
// account listing showed no job, immediately before sending the add. The entry is
// written before the request leaves, so it survives an interrupted preparation
// whose request cannot be cancelled. It is never cleared early, even when the
// provider answers with an error: a visible job makes callers skip the guard, and
// otherwise the entry expires after ten minutes. Process-local only: restarts and
// other servers do not share these attempts. At most 100 unexpired entries.
export const addGuard = (label: string) => {
  const attempts = new Map<string, number>();
  return Effect.fnUntraced(function* (key: string, hash: string) {
    // A digest keeps one account or hash from blocking another without retaining the key.
    const attempt = yield* Effect.tryPromise({
      try: async () =>
        Buffer.from(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify([key, hash])),
          ),
        ).toString("hex"),
      catch: () =>
        fail(`Could not identify the ${label} preparation. Try again.`),
    });
    const now = yield* Clock.currentTimeMillis;
    for (const [id, expires] of attempts)
      if (expires <= now) attempts.delete(id);
    if (attempts.has(attempt))
      return yield* Effect.fail(
        fail(
          `A recent ${label} preparation may still be processing. Wait at least ten minutes, then check your ${label} account before trying again.`,
        ),
      );
    if (attempts.size >= 100)
      return yield* Effect.fail(
        fail(
          `Too many recent ${label} preparations. Wait ten minutes, then check your ${label} account before trying again.`,
        ),
      );
    attempts.set(attempt, now + 600_000);
  });
};
