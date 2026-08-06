// Dev-only integration check — manual run, not in the test suite.
//
// Proves the recommender runs end-to-end through the REAL four seams against
// the live Supabase DB + live YouTube InnerTube, with no ZAI_API_KEY needed
// (the LLM tag prior falls back to pure co-occurrence when GLM isn't
// configured). This is the SC3 live proof that complements the in-app UAT.
//
// Self-contained: creates its OWN dev auth user + seeds a play via a direct
// admin insert, then runs `buildShelf` directly (NOT via the route — the route
// now requires a cookie session, which a standalone script doesn't carry).
//
// Run:
//   pnpm exec tsx --env-file=.env scripts/sp0-integration-check.ts
//
// Exit code: 0 if the slate is non-empty (real recommendations produced),
// 1 otherwise. Writes one scratch row to the dev user's music_plays.

import {
  buildShelf,
  createYoutubeCandidateSource,
} from "@music-ai/engine";
import { createSupabaseAdminClient } from "../lib/supabase/admin";
import { createSupabaseTrackStore } from "../lib/providers/track-store-supabase";
import { toNarrowTagStore } from "../lib/providers/tag-store-adapter";
import { createGlmLlm } from "../lib/providers/llm-glm";

const DEV_EMAIL = "music-check@local";
const DEV_PASSWORD = "musiccheckpassword123";
// A stable, real videoId so InnerTube radio returns tracks.
const SEED_TRACK = {
  track_id: "yt:dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  artist: "Rick Astley",
  thumbnail: null as string | null,
};

async function main(): Promise<void> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "[sp0-check] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (load .env).",
    );
    process.exit(1);
  }

  const admin = createSupabaseAdminClient();

  // 1. Ensure a dev auth user exists. Idempotent: list users first, reuse if
  //    "music-check@local" is already there.
  let devUserId: string;
  const { data: listData, error: listError } =
    await admin.auth.admin.listUsers();
  if (listError) {
    console.error("[sp0-check] listUsers failed:", listError.message);
    process.exit(1);
  }
  const existing = listData.users.find((u) => u.email === DEV_EMAIL);
  if (existing) {
    devUserId = existing.id;
    console.log(`[sp0-check] reusing existing dev user ${DEV_EMAIL} (${devUserId})`);
  } else {
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
        email_confirm: true,
      });
    if (createError || !created?.user) {
      console.error(
        "[sp0-check] createUser failed:",
        createError?.message ?? "no user returned",
      );
      process.exit(1);
    }
    devUserId = created.user.id;
    console.log(`[sp0-check] created dev user ${DEV_EMAIL} (${devUserId})`);
  }

  // 2. Seed a play via a DIRECT admin insert. The `log_music_play` RPC is
  //    auth-coupled (security invoker + auth.uid()) and fails under the service
  //    role — a plain upsert works because the admin client bypasses RLS.
  const { error: playError } = await admin
    .from("music_plays")
    .upsert(
      {
        user_id: devUserId,
        track_id: SEED_TRACK.track_id,
        title: SEED_TRACK.title,
        artist: SEED_TRACK.artist,
        thumbnail: SEED_TRACK.thumbnail,
      },
      { onConflict: "user_id,track_id" },
    );
  if (playError) {
    console.error("[sp0-check] seed play upsert failed:", playError.message);
    process.exit(1);
  }
  console.log(
    `[sp0-check] seeded play for ${SEED_TRACK.track_id} (${SEED_TRACK.title}).`,
  );

  // 3. Construct the real seams.
  //    - TrackStore: Supabase impl bound to the admin client + dev user.
  //    - CandidateSource: real anonymous InnerTube.
  //    - LlmProvider: real GLM if ZAI_API_KEY set, else isConfigured()=false
  //      (tag prior skipped, co-occurrence only — still produces a real slate).
  const trackStore = createSupabaseTrackStore(admin);
  const candidateSource = createYoutubeCandidateSource();
  const llm = createGlmLlm();
  console.log(`[sp0-check] GLM tag prior ${llm.isConfigured() ? "ENABLED" : "DISABLED (co-occurrence only)"}`);

  // 4. Load history (should include the seed) and build the slate through the
  //    four real seams.
  const history = await trackStore.loadHistory(devUserId);
  console.log(`[sp0-check] history rows: ${history.length}`);
  if (history.length === 0) {
    console.error("[sp0-check] history is empty after seed — aborting.");
    process.exit(1);
  }
  const seedPresent = history.some((h) => h.trackId === SEED_TRACK.track_id);
  console.log(`[sp0-check] seed present in history: ${seedPresent}`);

  // Bridge broad TrackStore → narrow TagStore (get/put) per tags.ts.
  const tagStore = toNarrowTagStore(trackStore);

  console.log("[sp0-check] building shelf through four real seams...");
  const started = Date.now();
  const slate = await buildShelf({
    history,
    candidateSource,
    tagStore,
    llm,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // 5. Report.
  console.log(`[sp0-check] slate built in ${elapsed}s — ${slate.length} tracks`);
  if (slate.length === 0) {
    console.error("[sp0-check] EMPTY slate — engine produced no recommendations.");
    console.error("    Debug: InnerTube reachability, seed validity, history load.");
    process.exit(1);
  }
  console.log("[sp0-check] first 5 tracks:");
  for (const track of slate.slice(0, 5)) {
    console.log(
      `    - ${track.trackId}  «${track.title}»  — ${track.artist ?? "(unknown)"}`,
    );
  }
  console.log("[sp0-check] OK — non-empty slate through the four real seams.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[sp0-check] unexpected error:", err);
  process.exit(1);
});
