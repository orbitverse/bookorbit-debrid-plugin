import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";

/**
 * Runs `work` for every source concurrently and reports what settled, in source order.
 *
 * Collection ends when every source has settled. Once `softMs` has passed it also ends as soon
 * as `satisfied` accepts the outcomes so far, and at `hardMs` it ends regardless. A slow source
 * therefore only delays an answer that could not have been given without it. Sources still
 * running when collection ends are interrupted and left `undefined`.
 */
export const collect = Effect.fnUntraced(function* <S, A, E, R>(
  sources: readonly S[],
  work: (source: S) => Effect.Effect<A, E, R>,
  options: {
    readonly softMs: number;
    readonly hardMs: number;
    readonly satisfied: (
      outcomes: readonly (Result.Result<A, E> | undefined)[],
    ) => boolean;
  },
) {
  const outcomes: (Result.Result<A, E> | undefined)[] = sources.map(
    () => undefined,
  );
  const enough = yield* Deferred.make<void>();
  let softPassed = false;
  const settle = Effect.forEach(
    sources,
    (source, index) =>
      work(source).pipe(
        Effect.result,
        Effect.flatMap((outcome) => {
          outcomes[index] = outcome;
          return softPassed && options.satisfied(outcomes)
            ? Deferred.succeed(enough, undefined)
            : Effect.void;
        }),
      ),
    { concurrency: "unbounded", discard: true },
  );
  const deadline = Effect.sleep(options.softMs).pipe(
    Effect.flatMap(() => {
      softPassed = true;
      return options.satisfied(outcomes)
        ? Effect.void
        : Effect.raceFirst(
            Deferred.await(enough),
            Effect.sleep(Math.max(0, options.hardMs - options.softMs)),
          );
    }),
  );
  yield* Effect.raceFirst(settle, deadline);
  // Judged from the outcomes: the last source can settle in the same step that ends the wait.
  return {
    outcomes: [...outcomes],
    expired: outcomes.some((outcome) => outcome === undefined),
  };
});
