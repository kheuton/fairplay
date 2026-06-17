/**
 * React Query hooks for Todoist data.
 * All queries are DISABLED when no token is configured.
 *
 * IMPORTANT: cardId is a card SLUG derived from the project name —
 * NOT a Todoist project id. Project membership is how tasks belong to cards.
 *
 * Query key design:
 *   ['deck']               → CardDef[], staleTime 5 min
 *   ['fp-tasks']           → all open FP tasks (excludes FP-item / FP-config carriers)
 *   ['fp-carriers', cid]   → FP-item + FP-config carrier tasks for a card
 *   ['fp-completed', days] → completed tasks in last N days
 *   ['fp-connection']      → token validation
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
  type QueryKey,
} from '@tanstack/react-query';
import { useStore } from 'zustand';
import { useSettings, getToken, useProfile } from '../../state/settings';
import { PROFILES } from '../../cards/deck-config';
import type { CardDef, FpTask, FpMeta, InvMeta } from '../types';
import { fetchAllPages, fetchAllCompletedPages, todoistGet, todoistPost, todoistDelete, type RawTask } from './client';
import { resolveDeck, buildProjectToCard } from './deck';
import { rawToFpTask, taskUrl } from './mapping';
import { parseFp, withFp } from '../metadata';
import { format } from 'date-fns';
import {
  parseCharter,
  serializeCharter,
  detectConceptTasks,
  absorbText,
  type CharterFields,
} from '../charter';

// ---------------------------------------------------------------------------
// Label constants for carrier tasks
// ---------------------------------------------------------------------------

const LABEL_ITEM = 'FP-item';
const LABEL_CONFIG = 'FP-config';
const LABEL_CHARTER = 'FP-charter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function localDateString(d?: Date): string {
  return format(d ?? new Date(), 'yyyy-MM-dd');
}

/** Subscribe to the settings store token so that when it changes, `enabled`
 *  re-evaluates and queries re-fire. We only need the token for enabled checks
 *  inside hook bodies; actual reads at call-time go through getToken(). */
function useTokenEnabled(): boolean {
  // useStore subscribes to the store; selector always returns current token state
  const token = useStore(useSettings, (s) => s.token);
  // Also allow env var token (non-reactive but present at startup)
  return !!(token || import.meta.env.VITE_TODOIST_API_TOKEN);
}

// ---------------------------------------------------------------------------
// Deck query
// ---------------------------------------------------------------------------

/** Resolved deck in Todoist child_order, stale after 5 min. */
export function useDeck(): UseQueryResult<CardDef[]> {
  const enabled = useTokenEnabled();
  const profile = useProfile();
  return useQuery<CardDef[]>({
    queryKey: ['deck', profile],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<CardDef[]> => {
      const projects = await fetchAllPages<Parameters<typeof resolveDeck>[0][0]>(
        '/api/v1/projects?limit=200'
      );
      return resolveDeck(projects, PROFILES[profile].deckParent);
    },
  });
}

/** Convenience: look up a single card from the deck cache. */
export function useCard(cardId: string): CardDef | undefined {
  const { data } = useDeck();
  return data?.find((c) => c.id === cardId);
}

// ---------------------------------------------------------------------------
// Task queries — all derive from a single ['fp-tasks'] cache via select
// ---------------------------------------------------------------------------

/**
 * Shared queryFn for all open-task hooks. Fetches one request per deck project
 * concurrently and converts raw tasks to FpTask (with FP:: meta parsed out).
 * Carrier tasks (FP-item, FP-config) are included; each hook's select filters them.
 *
 * All hooks share the same ['fp-tasks'] cache key so React Query deduplicates the
 * network request. The select function is memoized by React Query, meaning the
 * derived array reference is stable across renders when the underlying data is
 * unchanged — preventing unnecessary re-render churn in consumers.
 */
function makeTaskQueryFn(deck: CardDef[] | undefined) {
  return async (): Promise<FpTask[]> => {
    if (!deck) return [];
    const projectToCard = buildProjectToCard(deck);
    const deckIds = new Set(deck.map((c) => c.todoistId));

    const perProject = await Promise.all(
      deck.map((card) =>
        fetchAllPages<RawTask>(`/api/v1/tasks?project_id=${card.todoistId}&limit=200`)
      )
    );

    return perProject
      .flat()
      .filter((t) => deckIds.has(t.project_id))
      .map((t) => rawToFpTask(t, projectToCard));
  };
}

/**
 * All open FP tasks across all deck projects (excludes FP-item and FP-config carriers).
 * Uses React Query's select option so the derived array is memoized and stable.
 */
export function useDeckTasks(): UseQueryResult<FpTask[]> {
  const enabled = useTokenEnabled();
  const profile = useProfile();
  const { data: deck } = useDeck();

  return useQuery<FpTask[], Error, FpTask[]>({
    queryKey: ['fp-tasks', profile],
    enabled: enabled && !!deck,
    queryFn: makeTaskQueryFn(deck),
    select: (tasks) =>
      tasks.filter(
        (t) =>
          !t.labels.includes(LABEL_ITEM) &&
          !t.labels.includes(LABEL_CONFIG) &&
          !t.labels.includes(LABEL_CHARTER)
      ),
  });
}

/** Open FP tasks filtered to one card (excludes carriers). Memoized via select. */
export function useCardTasks(cardId: string): UseQueryResult<FpTask[]> {
  const enabled = useTokenEnabled();
  const profile = useProfile();
  const { data: deck } = useDeck();

  return useQuery<FpTask[], Error, FpTask[]>({
    queryKey: ['fp-tasks', profile],
    enabled: enabled && !!deck,
    queryFn: makeTaskQueryFn(deck),
    select: (tasks) =>
      tasks.filter(
        (t) =>
          t.cardId === cardId &&
          !t.labels.includes(LABEL_ITEM) &&
          !t.labels.includes(LABEL_CONFIG) &&
          !t.labels.includes(LABEL_CHARTER)
      ),
  });
}

/** FP-item carrier tasks for an inventory card. Memoized via select. */
export function useInventory(cardId: string): UseQueryResult<FpTask[]> {
  const enabled = useTokenEnabled();
  const profile = useProfile();
  const { data: deck } = useDeck();

  return useQuery<FpTask[], Error, FpTask[]>({
    queryKey: ['fp-tasks', profile],
    enabled: enabled && !!deck,
    queryFn: makeTaskQueryFn(deck),
    select: (tasks) =>
      tasks.filter((t) => t.cardId === cardId && t.labels.includes(LABEL_ITEM)),
  });
}

// ---------------------------------------------------------------------------
// Card config
// ---------------------------------------------------------------------------

/** FP-config carrier for a card, lazily created on first update. */
export function useCardConfig(cardId: string): {
  config: Record<string, unknown>;
  update: (patch: Record<string, unknown>) => void;
  isLoading: boolean;
} {
  const enabled = useTokenEnabled();
  const profile = useProfile();
  const qc = useQueryClient();
  const { data: deck } = useDeck();
  const card = deck?.find((c) => c.id === cardId);

  const query = useQuery<Record<string, unknown>>({
    queryKey: ['fp-config', profile, cardId],
    enabled: enabled && !!card,
    queryFn: async (): Promise<Record<string, unknown>> => {
      if (!card) return {};
      // Fetch all tasks for the card project, look for FP-config carrier
      const tasks = await fetchAllPages<RawTask>(
        `/api/v1/tasks?project_id=${card.todoistId}&limit=200`
      );
      const configTask = tasks.find((t) => t.labels.includes(LABEL_CONFIG));
      if (!configTask) return {};
      const { meta } = parseFp(configTask.description ?? '');
      return (meta.config as Record<string, unknown>) ?? {};
    },
  });

  const update = async (patch: Record<string, unknown>): Promise<void> => {
    if (!card) return;
    const token = getToken();
    if (!token) return;

    const tasks = await fetchAllPages<RawTask>(
      `/api/v1/tasks?project_id=${card.todoistId}&limit=200`
    );
    const configTask = tasks.find((t) => t.labels.includes(LABEL_CONFIG));

    // Source `current` from the freshly-fetched carrier so we don't clobber
    // sibling config keys that were written by another device/tab after our
    // last cache hydration. Falls back to the query cache only when no carrier
    // exists yet (first write).
    const { meta: fetchedMeta, clean: fetchedClean } = configTask
      ? parseFp(configTask.description ?? '')
      : { meta: {}, clean: `FairPlay config - ${cardId}` };
    const current = configTask
      ? ((fetchedMeta.config as Record<string, unknown>) ?? {})
      : (query.data ?? {});

    // Deep-merge nested objects (e.g. waterFilter) so a concurrent write to a
    // sibling key isn't silently overwritten when patch carries the same top-level
    // key. We merge patch into current at the top level, and for each key whose
    // value is a plain object in both current and patch, we merge one level deeper.
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      const cur = current[k];
      if (
        v !== null && typeof v === 'object' && !Array.isArray(v) &&
        cur !== null && typeof cur === 'object' && !Array.isArray(cur)
      ) {
        next[k] = { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) };
      } else {
        next[k] = v;
      }
    }

    if (configTask) {
      // Update existing config carrier using the fetched clean text
      const newDesc = withFp(fetchedClean, { config: next });
      await todoistPost(`/api/v1/tasks/${configTask.id}`, { description: newDesc });
    } else {
      // Create new config carrier
      const desc = withFp(`FairPlay config - ${cardId}`, { config: next });
      await todoistPost('/api/v1/tasks', {
        content: `FairPlay config - ${cardId}`,
        project_id: card.todoistId,
        description: desc,
        labels: [LABEL_CONFIG],
      });
    }

    await qc.invalidateQueries({ queryKey: ['fp-config', profile, cardId] });
    qc.setQueryData(['fp-config', profile, cardId], next);
  };

  return {
    config: query.data ?? {},
    update,
    isLoading: query.isLoading,
  };
}

// ---------------------------------------------------------------------------
// Completed tasks
// ---------------------------------------------------------------------------

/**
 * Completed tasks across deck projects within the last N days.
 *
 * Uses GET /api/v1/tasks/completed/by_completion_date with since/until datetimes.
 * The API enforces a max 3-month window per request; sinceDays is capped at 90.
 * Response envelope is { items: RawTask[], next_cursor? } — uses fetchAllCompletedPages.
 * Optionally filters by project_id; we fetch once without a project filter and then
 * filter client-side to deck project ids (fewer requests, same accuracy).
 *
 * VERIFIED: GET /api/v1/tasks/completed/by_completion_date
 *   Params: since (ISO datetime), until (ISO datetime), limit, cursor
 *   Response: { items: [...], next_cursor?: string }
 */
export function useCompletedTasks(sinceDays: number): UseQueryResult<FpTask[]> {
  const enabled = useTokenEnabled();
  const profile = useProfile();
  const { data: deck } = useDeck();

  // Cap at 90 days — API enforces a 3-month max window
  const clampedDays = Math.min(sinceDays, 90);

  return useQuery<FpTask[]>({
    queryKey: ['fp-completed', profile, clampedDays],
    enabled: enabled && !!deck,
    queryFn: async (): Promise<FpTask[]> => {
      if (!deck) return [];

      const projectToCard = buildProjectToCard(deck);
      const deckProjectIds = new Set(deck.map((c) => c.todoistId));

      const until = new Date();
      const since = new Date(until);
      since.setDate(since.getDate() - clampedDays);

      const sinceParam = encodeURIComponent(since.toISOString());
      const untilParam = encodeURIComponent(until.toISOString());

      const items = await fetchAllCompletedPages<RawTask>(
        `/api/v1/tasks/completed/by_completion_date?since=${sinceParam}&until=${untilParam}&limit=200`
      );

      return items
        .filter((t) => deckProjectIds.has(t.project_id))
        .map((t) => ({ ...rawToFpTask(t, projectToCard), isCompleted: true }));
    },
  });
}

// ---------------------------------------------------------------------------
// Connection check
// ---------------------------------------------------------------------------

/**
 * Connection status check — makes a cheap authenticated call.
 * Uses useTokenEnabled() (store subscription) so the check re-fires reactively
 * when the user sets a token in Settings, clearing the no-token banner without
 * requiring a page remount.
 */
export function useConnection(): {
  status: 'no-token' | 'checking' | 'ok' | 'error';
  error?: string;
} {
  // Reactive: re-evaluates when the store token changes (unlike a bare getToken() call)
  const enabled = useTokenEnabled();
  const query = useQuery<boolean>({
    queryKey: ['fp-connection'],
    enabled,
    retry: false,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<boolean> => {
      // Must resolve a non-undefined value: React Query v5 treats a queryFn
      // that resolves undefined as an error, which would pin status at 'error'.
      await todoistGet<unknown>('/api/v1/projects?limit=1');
      return true;
    },
  });

  if (!enabled) return { status: 'no-token' };
  if (query.isLoading || query.isPending) return { status: 'checking' };
  if (query.isError) return { status: 'error', error: String(query.error) };
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Close (complete) a task.
 * Optimistic update: removes the task from the ['fp-tasks'] cache immediately so
 * it disappears from the inbox/card list without waiting for the server round-trip.
 * For recurring tasks the advanced occurrence will reappear after the invalidation
 * refetch on settle. Rollback restores the removed task on error.
 */
export function useCloseTask(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  const profile = useProfile();
  return useMutation<void, Error, string>({
    mutationFn: async (taskId: string): Promise<void> => {
      await todoistPost<void>(`/api/v1/tasks/${taskId}/close`);
    },
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: ['fp-tasks', profile] });
      const prev = qc.getQueryData<FpTask[]>(['fp-tasks', profile]);
      // Remove from cache so the task disappears instantly (not just flagged)
      qc.setQueryData<FpTask[]>(['fp-tasks', profile], (old) =>
        old?.filter((t) => t.id !== taskId)
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      const c = ctx as { prev?: FpTask[] } | undefined;
      if (c?.prev) qc.setQueryData(['fp-tasks', profile], c.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
      // Also invalidate the completed-tasks cache so the Done tab immediately
      // reflects the newly-completed task (prefix match covers all sinceDays variants).
      void qc.invalidateQueries({ queryKey: ['fp-completed', profile] });
    },
  });
}

export function useDeleteItem(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  const profile = useProfile();
  return useMutation<void, Error, string>({
    mutationFn: async (taskId: string): Promise<void> => {
      await todoistDelete(`/api/v1/tasks/${taskId}`);
    },
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: ['fp-tasks', profile] });
      const prev = qc.getQueryData<FpTask[]>(['fp-tasks', profile]);
      qc.setQueryData<FpTask[]>(['fp-tasks', profile], (old) => old?.filter((t) => t.id !== taskId));
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      const c = ctx as { prev?: FpTask[] } | undefined;
      if (c?.prev) qc.setQueryData(['fp-tasks', profile], c.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
    },
  });
}

/**
 * Reopen a completed task.
 * Optimistic update: the task isn't currently in the open-tasks cache (it was
 * removed on close), so we just invalidate on settle to pull the reopened task
 * back in from the server. No rollback needed since nothing was removed.
 */
export function useReopenTask(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  const profile = useProfile();
  return useMutation<void, Error, string>({
    mutationFn: async (taskId: string): Promise<void> => {
      await todoistPost<void>(`/api/v1/tasks/${taskId}/reopen`);
    },
    // Optimistically remove the task from every completed-tasks cache (all
    // sinceDays variants) so a reopened Done row disappears before paint rather
    // than animating off and snapping back while the reopen round-trips.
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: ['fp-completed', profile] });
      const prev = qc.getQueriesData<FpTask[]>({ queryKey: ['fp-completed', profile] });
      qc.setQueriesData<FpTask[]>({ queryKey: ['fp-completed', profile] }, (old) =>
        old?.filter((t) => t.id !== taskId)
      );
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      const c = ctx as { prev?: Array<[QueryKey, FpTask[] | undefined]> } | undefined;
      if (c?.prev) for (const [key, data] of c.prev) qc.setQueryData(key, data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
      // Also invalidate the completed-tasks cache so reopened tasks stop appearing
      // in the Done tab immediately (prefix match covers all sinceDays variants).
      void qc.invalidateQueries({ queryKey: ['fp-completed', profile] });
    },
  });
}

export interface CreateTaskInput {
  content: string;
  /** Card slug — resolved to project_id via deck cache. */
  cardId: string;
  /** Todoist natural-language due string e.g. "every monday". */
  due?: string;
  description?: string;
  meta?: FpMeta;
  /** Extra labels (beyond any FP labels). */
  extraLabels?: string[];
}

export function useCreateTask(): UseMutationResult<FpTask, Error, CreateTaskInput> {
  const qc = useQueryClient();
  const profile = useProfile();
  const { data: deck } = useDeck();

  return useMutation<FpTask, Error, CreateTaskInput>({
    mutationFn: async (input: CreateTaskInput): Promise<FpTask> => {
      const card = deck?.find((c) => c.id === input.cardId);
      if (!card) throw new Error(`Card not found: ${input.cardId}`);

      const cleanDesc = input.description ?? '';
      const description = input.meta ? withFp(cleanDesc, input.meta) : cleanDesc;

      const body: Record<string, unknown> = {
        content: input.content,
        project_id: card.todoistId,
        description,
      };
      if (input.due) body.due_string = input.due;
      if (input.extraLabels?.length) body.labels = input.extraLabels;

      const raw = await todoistPost<RawTask>('/api/v1/tasks', body);
      const projectToCard = buildProjectToCard(deck ?? []);
      return rawToFpTask(raw, projectToCard);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
    },
  });
}

export interface UpdateTaskInput {
  id: string;
  patch: {
    content?: string;
    due?: string | null;
    description?: string;
    /** meta patch REPLACES the whole meta object */
    meta?: FpMeta;
  };
}

export function useUpdateTask(): UseMutationResult<FpTask, Error, UpdateTaskInput> {
  const qc = useQueryClient();
  const profile = useProfile();
  const { data: deck } = useDeck();

  return useMutation<FpTask, Error, UpdateTaskInput>({
    mutationFn: async (input: UpdateTaskInput): Promise<FpTask> => {
      // Fetch current task to get its clean description
      const current = await todoistGet<RawTask>(`/api/v1/tasks/${input.id}`);
      const { clean: currentClean } = parseFp(current.description ?? '');

      const body: Record<string, unknown> = {};
      if (input.patch.content !== undefined) body.content = input.patch.content;

      if (input.patch.due !== undefined) {
        if (input.patch.due === null) {
          body.due_string = 'no due date';
        } else {
          body.due_string = input.patch.due;
        }
      }

      // Build new description
      const cleanDesc =
        input.patch.description !== undefined ? input.patch.description : currentClean;
      const meta = input.patch.meta !== undefined ? input.patch.meta : null;
      if (input.patch.description !== undefined || input.patch.meta !== undefined) {
        body.description = meta ? withFp(cleanDesc, meta) : cleanDesc;
      }

      const raw = await todoistPost<RawTask>(`/api/v1/tasks/${input.id}`, body);
      const projectToCard = buildProjectToCard(deck ?? []);
      return rawToFpTask(raw, projectToCard);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
    },
  });
}

export interface AttestItemInput {
  taskId: string;
  count: number;
}

/** Sets meta.inv.count + verified=today (local date YYYY-MM-DD). */
export function useAttestItem(): UseMutationResult<void, Error, AttestItemInput> {
  const qc = useQueryClient();
  const profile = useProfile();
  return useMutation<void, Error, AttestItemInput>({
    mutationFn: async (input: AttestItemInput): Promise<void> => {
      const current = await todoistGet<RawTask>(`/api/v1/tasks/${input.taskId}`);
      const { meta, clean } = parseFp(current.description ?? '');
      const today = localDateString();
      const updatedMeta: FpMeta = {
        ...meta,
        inv: meta.inv
          ? { ...meta.inv, count: input.count, verified: today }
          : undefined,
      };
      // If there's no inv meta, create a minimal one
      if (!meta.inv) {
        // Can't attest without existing inv meta — skip silently
        return;
      }
      const newDesc = withFp(clean, updatedMeta);
      await todoistPost(`/api/v1/tasks/${input.taskId}`, { description: newDesc });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
    },
  });
}

export interface UpdateItemMetaInput {
  taskId: string;
  invPatch: Partial<InvMeta>;
}

export function useUpdateItemMeta(): UseMutationResult<void, Error, UpdateItemMetaInput> {
  const qc = useQueryClient();
  const profile = useProfile();
  return useMutation<void, Error, UpdateItemMetaInput>({
    mutationFn: async (input: UpdateItemMetaInput): Promise<void> => {
      const current = await todoistGet<RawTask>(`/api/v1/tasks/${input.taskId}`);
      const { meta, clean } = parseFp(current.description ?? '');
      const updatedMeta: FpMeta = {
        ...meta,
        inv: meta.inv
          ? { ...meta.inv, ...input.invPatch }
          : (input.invPatch as InvMeta),
      };
      const newDesc = withFp(clean, updatedMeta);
      await todoistPost(`/api/v1/tasks/${input.taskId}`, { description: newDesc });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
    },
  });
}

export interface SeedInventoryInput {
  cardId: string;
  items: Array<{ name: string; inv: InvMeta }>;
}

/** Bulk-create FP-item carrier tasks in the card's project. */
export function useSeedInventory(): UseMutationResult<void, Error, SeedInventoryInput> {
  const qc = useQueryClient();
  const profile = useProfile();
  const { data: deck } = useDeck();

  return useMutation<void, Error, SeedInventoryInput>({
    mutationFn: async (input: SeedInventoryInput): Promise<void> => {
      const card = deck?.find((c) => c.id === input.cardId);
      if (!card) throw new Error(`Card not found: ${input.cardId}`);

      await Promise.all(
        input.items.map((item) => {
          const description = withFp('', { inv: item.inv });
          return todoistPost('/api/v1/tasks', {
            content: item.name,
            project_id: card.todoistId,
            description,
            labels: [LABEL_ITEM],
          });
        })
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
    },
  });
}

// ---------------------------------------------------------------------------
// Charter hooks
// ---------------------------------------------------------------------------

/**
 * All FP-charter carriers across the deck, keyed by cardId.
 * Returns a Map<cardId, CharterFields | null> — null means no carrier exists yet.
 * Reads from the shared ['fp-tasks'] cache (carriers are not excluded there).
 */
export function useDeckCharters(): Map<string, CharterFields | null> {
  const enabled = useTokenEnabled();
  const profile = useProfile();
  const { data: deck } = useDeck();

  const query = useQuery<FpTask[], Error, Map<string, CharterFields | null>>({
    queryKey: ['fp-tasks', profile],
    enabled: enabled && !!deck,
    queryFn: makeTaskQueryFn(deck),
    select: (tasks) => {
      const map = new Map<string, CharterFields | null>();
      // Pre-populate all deck cards with null (no charter)
      if (deck) {
        for (const card of deck) {
          map.set(card.id, null);
        }
      }
      // Fill in parsed charter fields from carriers
      for (const t of tasks) {
        if (t.cardId && t.labels.includes(LABEL_CHARTER)) {
          map.set(t.cardId, parseCharter(t.description ?? ''));
        }
      }
      return map;
    },
  });

  return query.data ?? new Map();
}

export interface UseCharterResult {
  fields: CharterFields | null;
  exists: boolean;
  revised: string | null;
  save: (fields: CharterFields) => void;
  saving: boolean;
}

/**
 * Read and write the FP-charter carrier for a card.
 * Reads from the ['fp-tasks'] cache (select on LABEL_CHARTER for this card).
 * Save updates the carrier's description via serializeCharter + withFp,
 * lazily creating the task when absent.
 * Invalidates ['fp-tasks'] on settle.
 */
export function useCharter(cardId: string): UseCharterResult {
  const enabled = useTokenEnabled();
  const profile = useProfile();
  const qc = useQueryClient();
  const { data: deck } = useDeck();
  const card = deck?.find((c) => c.id === cardId);

  // Select the charter carrier for this card from the shared task cache
  const charterQuery = useQuery<FpTask[], Error, FpTask | null>({
    queryKey: ['fp-tasks', profile],
    enabled: enabled && !!deck,
    queryFn: makeTaskQueryFn(deck),
    select: (tasks) =>
      tasks.find(
        (t) => t.cardId === cardId && t.labels.includes(LABEL_CHARTER)
      ) ?? null,
  });

  const charterTask = charterQuery.data ?? null;
  const exists = charterTask !== null;

  const fields: CharterFields | null = charterTask
    ? parseCharter(charterTask.description ?? '')
    : null;

  const revised =
    charterTask &&
    typeof charterTask.meta.charter === 'object' &&
    charterTask.meta.charter !== null &&
    typeof (charterTask.meta.charter as Record<string, unknown>).revised === 'string'
      ? (charterTask.meta.charter as Record<string, unknown>).revised as string
      : null;

  const mutation = useMutation<void, Error, CharterFields>({
    mutationFn: async (next: CharterFields): Promise<void> => {
      if (!card) throw new Error(`Card not found: ${cardId}`);
      const token = getToken();
      if (!token) throw new Error('No token');

      const today = localDateString();
      const cleanDesc = serializeCharter(next);
      const newMeta = { charter: { revised: today } };
      const newDesc = withFp(cleanDesc, newMeta);

      if (charterTask) {
        await todoistPost(`/api/v1/tasks/${charterTask.id}`, { description: newDesc });
      } else {
        await todoistPost('/api/v1/tasks', {
          content: `Card charter — ${card.name}`,
          project_id: card.todoistId,
          description: newDesc,
          labels: [LABEL_CHARTER],
        });
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
    },
  });

  return {
    fields,
    exists,
    revised,
    save: (f: CharterFields) => mutation.mutate(f),
    saving: mutation.isPending,
  };
}

export interface AbsorbCharterResult {
  absorbed: number;
}

/**
 * Absorb seeded concept tasks into the card's charter.
 * Detects concept tasks via detectConceptTasks, fills only empty charter fields,
 * saves the updated charter, then closes the original tasks (reversible).
 */
export function useAbsorbCharter(): UseMutationResult<
  AbsorbCharterResult,
  Error,
  { cardId: string }
> {
  const qc = useQueryClient();
  const profile = useProfile();
  const { data: deck } = useDeck();

  return useMutation<AbsorbCharterResult, Error, { cardId: string }>({
    mutationFn: async ({ cardId }): Promise<AbsorbCharterResult> => {
      const card = deck?.find((c) => c.id === cardId);
      if (!card) throw new Error(`Card not found: ${cardId}`);

      // Fetch the latest task list directly (bypass cache for fresh state)
      const projectToCard = buildProjectToCard(deck ?? []);
      const rawTasks = await fetchAllPages<RawTask>(
        `/api/v1/tasks?project_id=${card.todoistId}&limit=200`
      );
      const allTasks = rawTasks.map((t) => rawToFpTask(t, projectToCard));

      // Open todos for this card (excludes carriers)
      const cardTodos = allTasks.filter(
        (t) =>
          t.cardId === cardId &&
          !t.labels.includes(LABEL_ITEM) &&
          !t.labels.includes(LABEL_CONFIG) &&
          !t.labels.includes(LABEL_CHARTER)
      );

      // Find the charter carrier
      const charterTask = allTasks.find(
        (t) => t.cardId === cardId && t.labels.includes(LABEL_CHARTER)
      ) ?? null;

      // Current charter fields (empty if no carrier exists yet)
      const currentFields: CharterFields = charterTask
        ? parseCharter(charterTask.description ?? '')
        : { msc: '', conception: '', planning: '', execution: '' };

      // Detect concept tasks
      const matches = detectConceptTasks(cardTodos);
      if (matches.length === 0) return { absorbed: 0 };

      // Fill only empty fields
      const nextFields: CharterFields = { ...currentFields };
      const toClose: string[] = [];

      for (const { field, task } of matches) {
        if (!nextFields[field]) {
          nextFields[field] = absorbText(task);
          toClose.push(task.id);
        }
      }

      if (toClose.length === 0) return { absorbed: 0 };

      // Save the updated charter
      const today = localDateString();
      const cleanDesc = serializeCharter(nextFields);
      const newDesc = withFp(cleanDesc, { charter: { revised: today } });

      if (charterTask) {
        await todoistPost(`/api/v1/tasks/${charterTask.id}`, { description: newDesc });
      } else {
        await todoistPost('/api/v1/tasks', {
          content: `Card charter — ${card.name}`,
          project_id: card.todoistId,
          description: newDesc,
          labels: [LABEL_CHARTER],
        });
      }

      // Close original concept tasks
      await Promise.all(
        toClose.map((id) => todoistPost(`/api/v1/tasks/${id}/close`))
      );

      return { absorbed: toClose.length };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['fp-tasks', profile] });
      void qc.invalidateQueries({ queryKey: ['fp-completed', profile] });
    },
  });
}

// ---------------------------------------------------------------------------
// Water-filter hook
// ---------------------------------------------------------------------------

import {
  normalizeFilter,
  filterStatus,
  filterDaysLeft,
  filterLifeFrac,
  filterPct,
  filterChip,
  filterReplaceBy,
  filterDateLabel,
  type FilterState,
} from '../filter-health';

export type { FilterState };

export interface UseWaterFilterResult {
  state: FilterState;
  status: 'ok' | 'low' | 'out';
  daysLeft: number;
  lifeFrac: number;
  pct: number;
  replaceByLabel: string;
  chip: string;
  isLoading: boolean;
  markReplaced: () => void;
  setLifespan: (days: number) => void;
  setInstalled: (date: string) => void;
  setWarnDays: (n: number) => void;
}

/**
 * Derives water-filter health state from the card's FP-config carrier.
 * config.waterFilter (unknown) is coerced via normalizeFilter.
 * Mutations update the config in-place (fully reversible, no destructive writes).
 */
export function useWaterFilter(cardId: string): UseWaterFilterResult {
  const { config, update, isLoading } = useCardConfig(cardId);
  const now = new Date();

  const raw = config.waterFilter as Partial<FilterState> | undefined;
  const state = normalizeFilter(raw, now);

  const status = filterStatus(state, now);
  const daysLeft = filterDaysLeft(state, now);
  const lifeFrac = filterLifeFrac(state, now);
  const pct = filterPct(state, now);
  const chip = filterChip(state, now);
  const replaceByLabel = filterDateLabel(filterReplaceBy(state));

  // Each mutator sends only the changed field. The update() function deep-merges
  // the patch into the latest persisted waterFilter (read from the freshly-fetched
  // carrier), preventing the lost-update race that would occur if two blurs fire
  // before the first POST returns and both spread the same stale rendered `state`.
  function markReplaced(): void {
    void update({ waterFilter: { installed: localDateString() } });
  }

  function setLifespan(days: number): void {
    void update({ waterFilter: { lifespanDays: days } });
  }

  function setInstalled(date: string): void {
    void update({ waterFilter: { installed: date } });
  }

  function setWarnDays(n: number): void {
    void update({ waterFilter: { warnDays: n } });
  }

  return {
    state,
    status,
    daysLeft,
    lifeFrac,
    pct,
    replaceByLabel,
    chip,
    isLoading,
    markReplaced,
    setLifespan,
    setInstalled,
    setWarnDays,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------
export { todoistDelete };
export type { FpTask, FpMeta, InvMeta, CardDef, CharterFields };
