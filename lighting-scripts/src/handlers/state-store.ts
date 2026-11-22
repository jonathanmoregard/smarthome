/**
 * `state-store`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/state-store.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import {
  cachedProfile, catalogEffectChannels, parseOverrideBlockArgs, parseStoreProfile, parseViaArgs, scheduledBlocks,
} from '../parse/state-store.ts';
import { parseCommitArgs } from '../parse/overrides.ts';
import { commitSnapshot } from '../parse/state-store.ts';
import { overridesRevision, savedOverridesContain } from '../parse/sensors.ts';
import { run } from '../runtime/effects.ts';
import type { Plan } from '../runtime/effects.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { houseRooms, planCommit, planOverrideBlock, planStore, toggleSaraMode } from '../domain/state-store.ts';
import type { CommitArgs, CommitResult, StoreProfileArgs } from '../domain/state-store.ts';
import { SARA_MODE } from '../domain/types/overlay.ts';

/**
 * The single override writer: stale-revision stop, then the decision, then a
 * live re-read. The answer's revision and `committed_at` are read after the
 * writes, where the captured script reads them; the clock is live.
 */
export function commit(ctx: ScriptContext, args: CommitArgs): CommitResult {
  // Captured: `data.get('expected_revision') in [none, <bare read>]` builds the
  // list whatever the expected revision is, so the read always happens here.
  const currentRevision = overridesRevision(ctx, 'ls_commit');
  if (args.expectedRevision != null && args.expectedRevision !== currentRevision) return { accepted: false };
  const parsed = args.details();
  run(ctx, planCommit(commitSnapshot(ctx), parsed));
  return { accepted: true, revision: overridesRevision(ctx, 'ls_commit'), committed_at: recordTimestamp(ctx.now) };
}
/** Writes the profile store and answers nothing; every path returns null. */
export function storeProfile(ctx: ScriptContext, args: StoreProfileArgs): null {
  // The saved profile raises on a non-mapping cache before the catalog is fetched.
  const current = cachedProfile(ctx.get(args.entity));
  // `catalog.effects.get(key, {}).get('channels', [])`, over the raw result:
  // the `effects_catalog` call is recorded in `scriptRuns`, so it stays a call.
  return run(ctx, planStore(args, current, catalogEffectChannels(ctx.run('effects_catalog'))));
}
export function* clearAllOverrides(via: Verbatim): Plan<null> {
  yield { kind: 'event', event: 'ls_override', data: { op: 'clear_all', via } };
  return null;
}

export const stateStoreHandlers: ScriptHandlers = {
  // Captured `data` is accessed as a mapping throughout. Its nested fields are:
  // expected_revision raw once; op raw four times with one `get(..., 'set')`;
  // records three times with `get(..., [])`; area seven raw sites; via five;
  // who twice with one `or none`; keys/lights once each with empty-list
  // fallbacks; reason/received_at once each with `get` fallbacks; source and
  // request_id twice each behind truthiness gates; on once through HA `| bool`;
  // profile four comparison-only sites; min/max three sites each behind Jinja
  // `is number`; ranges once with `get(..., {})`, then bright/cosy four sites
  // each (sequence, length, two indexes). Record key/kind/source/target/value/
  // scope occur 2/5/2/6/1/3 times; value.channels has one empty-object fallback.
  // Keep the stale-revision stop ahead of every other parse and make operation-
  // specific strict fields lazy, matching the captured short-circuit order.
  ls_commit: typed('ls_commit', { parse: parseCommitArgs, run: commit }),
  // Captured `store` is required; every other field is guarded `is defined and
  // is not none` and carries its own filter (see `parseStoreProfile`). The
  // saved profile's two reads are `dict.get`, so an explicit null is a value.
  ls_store: withParsedArgs({ parse: parseStoreProfile, run: storeProfile }),
  // Captured scope is raw twice (list construction and comparison), block has
  // one `| lower`, and via has two `| default('app')` sites.
  ls_override_block: withParsedArgs({
    parse: parseOverrideBlockArgs,
    run: (ctx, args) => {
      const scheduledTo = scheduledBlocks(ctx.run('ls_apply', { dry_run: true }));
      return run(ctx, planOverrideBlock(args, args.scope.isHouse ? houseRooms(ctx) : [], scheduledTo));
    },
  }),
  // Captured via has one `| default('app')` site; explicit null/falsy values
  // survive because Jinja default only replaces Undefined.
  ls_clear_overrides: withParsedArgs({ parse: parseViaArgs, run: (ctx, via) => run(ctx, clearAllOverrides(via)) }),
  // Captured via has two `| default('app')` sites with the same semantics.
  ls_sara_mode: withParsedArgs({
    parse: parseViaArgs,
    run: (ctx, via) => run(ctx, toggleSaraMode(savedOverridesContain(ctx, SARA_MODE), via)),
  }),
};
