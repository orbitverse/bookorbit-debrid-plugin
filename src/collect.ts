import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/**
 * Runs `work` for every source concurrently and returns, in source order, what each one had made
 * known when collection ended, how far it got, and its failure if it failed.
 *
 * A source calls `known` with items as it learns them, first when it has answered (with none, if
 * it has none yet) and again whenever it learns more.
 *
 * Collection ends when every source has finished. Once `softMs` has passed it also ends as soon
 * as a source that finished without failing knows an item that `matches`, and at `hardMs` it ends
 * regardless. Until `softMs` collection therefore waits for every source; only after it does a
 * slow source stop delaying an answer that is already there.
 *
 * Only a source finishing or a clock passing can end collection. What a source makes known on
 * the way is recorded whole and never ends it, and nothing is recorded once it has ended. Sources
 * still running at that moment are interrupted; what they had made known is kept.
 */
export const collect = Effect.fnUntraced(function* <S, A, E, R>(
  sources: readonly S[],
  work: (
    source: S,
    known: (items: readonly A[]) => Effect.Effect<void>,
  ) => Effect.Effect<void, E, R>,
  options: {
    readonly softMs: number;
    readonly hardMs: number;
    readonly matches: (item: A) => boolean;
  },
) {
  const state = sources.map(
    (): {
      known: A[];
      stage: "waiting" | "answered" | "finished";
      failure?: E;
    } => ({ known: [], stage: "waiting" }),
  );
  const enough = yield* Deferred.make<void>();
  let softPassed = false;
  let closed = false;
  /** Records a source finishing or the soft clock passing, then ends collection if it may. */
  const settle = (change: () => void) =>
    Effect.suspend(() => {
      if (closed) return Effect.void;
      change();
      const satisfied =
        softPassed &&
        state.some(
          (source) =>
            source.stage === "finished" &&
            !source.failure &&
            source.known.some(options.matches),
        );
      if (!satisfied) return Effect.void;
      closed = true;
      return Effect.asVoid(Deferred.succeed(enough, undefined));
    });
  const run = Effect.forEach(
    sources,
    (source, index) => {
      const mine = state[index];
      return work(source, (items) =>
        Effect.sync(() => {
          if (closed) return;
          mine.known.push(...items);
          mine.stage = "answered";
        }),
      ).pipe(
        Effect.result,
        Effect.flatMap((outcome) =>
          settle(() => {
            mine.stage = "finished";
            if (Result.isFailure(outcome)) mine.failure = outcome.failure;
          }),
        ),
      );
    },
    { concurrency: "unbounded", discard: true },
  );
  const deadline = Effect.sleep(options.softMs).pipe(
    Effect.andThen(
      settle(() => {
        softPassed = true;
      }),
    ),
    Effect.andThen(
      Effect.raceFirst(
        Deferred.await(enough),
        Effect.sleep(Math.max(0, options.hardMs - options.softMs)),
      ),
    ),
  );
  yield* Effect.raceFirst(run, deadline);
  closed = true;
  return state;
});
