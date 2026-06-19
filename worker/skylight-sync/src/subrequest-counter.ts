/**
 * SubrequestCounter — tracks every subrequest-consuming operation in a Worker invocation.
 *
 * On Cloudflare Workers (free plan), the following ALL count against the 50-subrequest cap:
 *   - fetch() calls (HTTP requests to Skylight, Todoist)
 *   - D1 database calls (.run(), .first(), .all())
 *   - KV namespace calls (.get(), .put(), .delete())
 *
 * Usage:
 *   const counter = new SubrequestCounter();
 *   counter.incrementSkylight();   // one Skylight HTTP call
 *   counter.incrementTodoist();    // one Todoist HTTP call
 *   counter.incrementD1();         // one D1 statement execution
 *   counter.incrementKV();         // one KV operation
 *   counter.total                  // total subrequests so far
 *   counter.canAfford(n)           // true if total + n <= budget
 *   counter.breakdown()            // log-ready string
 */

export const SUBREQUEST_BUDGET = 40; // conservative cap (free plan limit = 50)

/**
 * How many subrequests to RESERVE for the run tail after the LAST outbound create.
 *
 * The tail covers:
 *   - 1  batched-create-verify (batchFetchChoresByIds) = 1 Skylight GET
 *   - 1  db.batch() for all commit/needs_review statements = 1 D1 call
 *   - 1  inbound batched chore fetch = 1 Skylight GET
 *   - 1  getReviewRows D1 call
 *   - 2  releaseLease (D1 SELECT + UPDATE/INSERT)
 *   - 2  KV token reads/writes (already paid at startup for warm token)
 *
 * NOTE: inbound Todoist getTask calls (1 per active mapping) and inbound D1 writes
 * are NOT counted here because the inbound pass now has its OWN per-row budget guard
 * (see INBOUND_ROW_COST + inbound canAfford check in runInboundPass). The inbound
 * guard defers rows it can't afford, so the inbound pass is self-bounding within
 * whatever budget remains after TAIL_RESERVE.
 *
 * The constants below govern outbound deferral (TAIL_RESERVE) and inbound deferral
 * (INBOUND_ROW_COST × rows remaining). Both must fit together within SUBREQUEST_BUDGET.
 *
 * Minimum tail cost (no creates, no inbound processing, just lease release + review):
 *   releaseLease(2) + getReviewRows(1) = 3
 * We use 8 to leave margin for unexpected overhead.
 */
export const TAIL_RESERVE = 8;

/**
 * Estimated subrequest cost of processing ONE active mapping in the inbound pass.
 *
 * Per-row costs (chore surface, batch succeeded):
 *   - 1  getTaskFn (Todoist GET)
 *   - 1  updateObservedStatus (D1 write, only when status changes)
 *   Per-completion (rare): completeChore/deleteChore/closeTask add more, but those
 *   are bounded by the per-row guard too.
 *
 * We use 2 (1 Todoist + 1 D1) as the per-row estimate.
 * The guard fires conservatively: it stops when budget - used < INBOUND_ROW_COST.
 */
export const INBOUND_ROW_COST = 2;

/**
 * Worst-case subrequest costs for outbound MUTATION actions.
 *
 * These are used by the outbound mutation budget guard to gate each action
 * BEFORE it begins. The estimates are intentionally conservative (upper-bound)
 * so that the guard never leaves a half-completed multi-step action.
 *
 * COMPLETE_CHORE (runCompleteProtocol):
 *   getChoreById(1 Skylight) + completeChore(1 Skylight) +
 *   verifyCompleted/getChoreById(1 Skylight) + updatePushedStatus(1 D1) = 4
 *
 * DELETE_CHORE (runDeleteProtocol):
 *   getChoreById(1 Skylight) + markDeleting(1 D1) + deleteChore(1 Skylight) +
 *   verifyDeleted/getChoreById(1 Skylight) + hardDeleteRow(1 D1) = 5
 *
 * ROLL_CHORE (runRollProtocol) = delete (~5) + create (~3):
 *   delete protocol (5) + getMappingByTodoistId (1 D1) +
 *   insertCreatingRow (1 D1) + createChore (1 Skylight) +
 *   getChoreById readback (1 Skylight) + commitActiveRow (1 D1) = ~10
 *   We use 10 as the conservative bound.
 *
 * MIGRATE_SURFACE (runMigrateSurfaceProtocol) = delete (~5) + create (~3):
 *   Same as ROLL_CHORE — conservative bound of 10.
 */
export const MUTATION_COST_COMPLETE = 4;
export const MUTATION_COST_DELETE = 5;
export const MUTATION_COST_ROLL = 10;
export const MUTATION_COST_MIGRATE = 10;

export class SubrequestCounter {
  private _skylight = 0;
  private _todoist = 0;
  private _d1 = 0;
  private _kv = 0;
  readonly budget: number;

  constructor(budget = SUBREQUEST_BUDGET) {
    this.budget = budget;
  }

  incrementSkylight(n = 1): void { this._skylight += n; }
  incrementTodoist(n = 1): void { this._todoist += n; }
  incrementD1(n = 1): void { this._d1 += n; }
  incrementKV(n = 1): void { this._kv += n; }

  get skylight(): number { return this._skylight; }
  get todoist(): number { return this._todoist; }
  get d1(): number { return this._d1; }
  get kv(): number { return this._kv; }

  get total(): number {
    return this._skylight + this._todoist + this._d1 + this._kv;
  }

  /**
   * Returns true when (total + reserve + additionalNeeded) fits within budget.
   * Use this BEFORE starting a new create to ensure the tail + the create itself
   * won't bust the cap.
   *
   * @param tailReserve  How many subrequests to hold back for the run tail.
   * @param additionalNeeded  Subrequests this create will consume (POST + D1 write-ahead = 2).
   */
  canAfford(tailReserve: number, additionalNeeded: number): boolean {
    return this.total + tailReserve + additionalNeeded <= this.budget;
  }

  breakdown(): string {
    return (
      `subrequest-breakdown: skylight=${this._skylight} todoist=${this._todoist} ` +
      `d1=${this._d1} kv=${this._kv} total=${this.total} (budget=${this.budget})`
    );
  }
}
