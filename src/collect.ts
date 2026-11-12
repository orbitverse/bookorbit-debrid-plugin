import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/** How a source tells the collection what it knows while it is still working. */
export interface Progress<A> {
  /** The source has answered: `items` are known now, and `lookups` more are still being looked up. */
  readonly answered: (
    items: readonly A[],
    lookups: number,
  ) => Effect.Effect<void>;
  /** One of those lookups has finished, with whatever it found. */
  readonly lookedUp: (items: readonly A[]) => Effect.Effect<void>;
}

/**
 * Runs `work` for every source concurrently and returns, in source order, what each one had
 * reported when collection ended: the items it knows, how far it got, how many of its lookups
 * were still running, and its failure if it failed.
 *
 * Collection ends when every source has finished. Once `softMs` has passed it also ends as soon
 * as a source that finished without failing knows an item that `matches`, and at `hardMs` it ends
 * regardless. Until `softMs` collection therefore waits for every source; only after it does a
 * slow source stop delaying an answer that is already there.
 *
 * Only a source finishing or a clock passing can end collection. What a source reports on the
 * way is recorded whole and never ends it, and nothing is recorded once it has ended. Sources
 * still running at that moment are interrupted; what they had reported is kept.
 */
export const collect = Effect.fnUntraced(function* <S, A, E, R>(
  sources: readonly S[],
  work: (source: S, progress: Progress<A>) => Effect.Effect<void, E, R>,
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
      lookups: number;
      failure?: E;
    } => ({ known: [], stage: "waiting", lookups: 0 }),
  );
  const enough = yield* Deferred.make<void>();
  let softPassed = false;
  let closed = false;
  /** Records what a source reports while it works. */
  const note = (change: () => void) =>
    Effect.sync(() => {
      if (!closed) change();
    });
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
      return work(source, {
        answered: (items, lookups) =>
          note(() => {
            mine.known.push(...items);
            mine.stage = "answered";
            mine.lookups = lookups;
          }),
        lookedUp: (items) =>
          note(() => {
            mine.known.push(...items);
            mine.lookups--;
          }),
      }).pipe(
        Effect.result,
        Effect.flatMap((outcome) =>
          settle(() => {
            mine.stage = "finished";
            mine.lookups = 0;
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
