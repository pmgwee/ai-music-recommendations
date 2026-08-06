import type { TagStore, TrackStore } from "@music-ai/engine";

/**
 * Bridge the broad `TrackStore` (per-track `getTags`/`setTags`) to the narrow
 * `TagStore` the engine consumes (`get(ids) → Map`, `put(entries)`).
 *
 * The engine's narrow seam (`packages/music-engine/src/tags.ts`) is batch-shaped
 * (get many ids at once, put many entries at once); the broad store exposes only
 * per-track reads/writes. This adapter fans the narrow `get` out to per-track
 * reads and folds `put` down to per-track writes — the "Bridge the broad →
 * narrow tagStore" decision from the SP-0 brief.
 *
 * NOTE: the brief's plan doc specified `toNarrowTagStore(broad, userId)`, but
 * the broad `TrackStore.getTags/setTags` API is catalog-global (tags are the
 * same for everyone — no `userId` argument), so a `userId` param would be dead
 * code. It is omitted here for parity with the `_userId` removal in
 * `createSupabaseTrackStore`; reintroduce it when/if the broad tag API becomes
 * user-scoped.
 */
export function toNarrowTagStore(broad: TrackStore): TagStore {
  return {
    get: async (ids) => {
      const out = new Map<string, string[]>();
      await Promise.all(
        ids.map(async (id) => {
          const tags = await broad.getTags(id);
          if (tags && tags.length > 0) out.set(id, tags);
        }),
      );
      return out;
    },
    put: async (entries) => {
      for (const entry of entries) await broad.setTags(entry.trackId, entry.tags);
    },
  };
}
