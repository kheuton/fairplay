/**
 * Counted wrappers for D1Database and KVNamespace.
 *
 * Each wrapper delegates to the real implementation and increments
 * a SubrequestCounter on every subrequest-consuming call.
 *
 * These are used in the scheduled handler to track subrequest consumption
 * and enforce the budget guard. They are typed as the real interfaces via
 * type assertions so they can be passed to any function expecting D1Database
 * or KVNamespace without breaking the existing API surface.
 */

import type { SubrequestCounter } from './subrequest-counter.js';

// ---------------------------------------------------------------------------
// CountedD1 — wraps D1Database, counting every statement execution
// ---------------------------------------------------------------------------

/**
 * Create a D1Database proxy that increments the counter on every
 * statement-level operation (.run, .first, .all) and on .batch() / .exec().
 *
 * Uses a Proxy so we don't need to enumerate every method of D1Database —
 * the proxy intercepts `prepare` and `batch`/`exec`, and all other access
 * falls through to the underlying db object.
 *
 * The returned value IS-A D1Database (structural, via Proxy).
 */
export function makeCountedD1(db: D1Database, counter: SubrequestCounter): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => makeCountedStatement(target.prepare(sql), counter);
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          counter.incrementD1();
          return target.batch(statements);
        };
      }
      if (prop === 'exec') {
        return async (query: string) => {
          counter.incrementD1();
          return target.exec(query);
        };
      }
      if (prop === 'dump') {
        return async () => {
          counter.incrementD1();
          return target.dump();
        };
      }
      // Everything else (withSession, etc.) falls through unchanged
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}

function makeCountedStatement(
  stmt: D1PreparedStatement,
  counter: SubrequestCounter
): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop) {
      if (prop === 'bind') {
        return (...values: unknown[]) => makeCountedStatement(target.bind(...values), counter);
      }
      if (prop === 'run') {
        return async () => {
          counter.incrementD1();
          return target.run();
        };
      }
      if (prop === 'first') {
        return async <T>(colName?: string) => {
          counter.incrementD1();
          return colName !== undefined
            ? (target as unknown as { first(col: string): Promise<T | null> }).first(colName)
            : target.first<T>();
        };
      }
      if (prop === 'all') {
        return async <T>() => {
          counter.incrementD1();
          return target.all<T>();
        };
      }
      if (prop === 'raw') {
        return async <T>(...args: unknown[]) => {
          counter.incrementD1();
          return (target as unknown as { raw(...a: unknown[]): Promise<T[]> }).raw(...args);
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}

// ---------------------------------------------------------------------------
// CountedKV — wraps KVNamespace, counting every get() and put()
// ---------------------------------------------------------------------------

/**
 * Create a KVNamespace proxy that increments the counter on every
 * .get(), .put(), .delete(), .list(), and .getWithMetadata() call.
 */
export function makeCountedKV(kv: KVNamespace, counter: SubrequestCounter): KVNamespace {
  return new Proxy(kv, {
    get(target, prop) {
      if (
        prop === 'get' ||
        prop === 'put' ||
        prop === 'delete' ||
        prop === 'list' ||
        prop === 'getWithMetadata'
      ) {
        const original = (target as unknown as Record<string | symbol, unknown>)[prop] as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return async (...args: unknown[]) => {
          counter.incrementKV();
          return original.apply(target, args);
        };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}
