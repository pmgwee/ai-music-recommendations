/**
 * Top-N diversity judge — ADR-0007's *deferred* LLM judge, shippable as an
 * app-level post-filter on the behaviourally-ranked slate.
 *
 * The engine's `buildShelf` is purely behavioural (co-occurrence, ranking,
 * transition bias). That already produces a strong top-of-slate, but a cold
 * catalogue + sparse history can still let a clunker through at positions 1–10.
 * The judge asks a configured BYOK LLM "given this listener's taste, which of
 * these (at most 10) is most likely a jarring fit?" and drops up to 2.
 *
 * Five guarantees the caller can rely on — the judge is:
 *   - **Gated** — returns an empty set when no LLM is configured or the slate
 *     is too short (< 8). No-LLM users get the engine slate unchanged.
 *   - **Bounded** — at most 10 tracks in, at most 2 drops out, exactly one LLM
 *     call per invocation. Cost is predictable per shelf build.
 *   - **Mitigated** — input is **shuffled** before prompting (position-bias
 *     mitigation: LLMs overweight the first token they see), and each track is
 *     labelled with an opaque ref `t1..tN` (NOT the real videoId/trackId) so
 *     the model can't parrot an id back. The shuffle RNG is injectable so tests
 *     can pin order.
 *   - **Defensive** — every failure mode (LLM throw, non-JSON response, missing
 *     `drop` field, out-of-range refs, malformed entries) collapses to an empty
 *     set. The judge never throws; worst case = no drops = engine slate as-is.
 *   - **Pure-ish** — depends only on the `LlmProvider` seam + engine types; no
 *     Next/Supabase imports, so it unit-tests with a hand-rolled mock LLM.
 *
 * The judge is NEVER the song-picker — the engine ranks, the judge only
 * refines the top of the ranking. ADR-0007 §"Deferred" is the governing doc.
 */
import type { LlmProvider, MusicTrack } from "@music-ai/engine";
import type { TasteProfile } from "./profile";

/** Maximum tracks considered — the engine's top-N is already strong, so a
 *  deeper window spends LLM budget on positions the listener may not reach. */
const MAX_TOP_N = 10;
/** Minimum slate length before the judge is worth its cost — under this the
 *  slate is too short to meaningfully mitigate bias or absorb a 2-drop. */
const MIN_SLATE_FOR_JUDGE = 8;
/** Hard cap on drops — keeps a noisy LLM response from gutting the slate. */
const MAX_DROPS = 2;

/** Injectable RNG so tests can pin the shuffle deterministically. */
export type Rng = () => number;

/**
 * Returns the set of `trackId`s the LLM flagged as clunkers (to be dropped
 * from the slate). Always resolves — never throws. Empty set ⇒ no drops.
 *
 * @param llm       The BYOK LLM (or NullLlm at the call site).
 * @param topSlate  The top of the engine's ranked slate. Only the first
 *                  `MAX_TOP_N` are considered; the rest are passed through.
 * @param profile   The listener's taste profile (top artists + tags).
 * @param rng       Injectable shuffle RNG (defaults to Math.random).
 */
export async function diversityJudge(
  llm: LlmProvider,
  topSlate: MusicTrack[],
  profile: TasteProfile,
  rng: Rng = Math.random,
): Promise<Set<string>> {
  // --- Guards (gated) -------------------------------------------------------
  // No LLM → skip (engine slate as-is). Short slate → not worth the call.
  if (!llm.isConfigured()) return new Set();
  if (topSlate.length < MIN_SLATE_FOR_JUDGE) return new Set();

  // --- Bounded + mitigated preparation -------------------------------------
  const window = topSlate.slice(0, MAX_TOP_N);
  const shuffled = shuffle(window, rng);

  // Opaque refs t1..tN — the LLM never sees real ids and so can't parrot them.
  // refs[i] is the ref label; back is the reverse map (ref → trackId).
  const refs: string[] = [];
  const back = new Map<string, string>();
  for (let i = 0; i < shuffled.length; i++) {
    const ref = `t${i + 1}`;
    refs.push(ref);
    back.set(ref, shuffled[i]!.trackId);
  }

  const messages = buildPrompt(shuffled, refs, profile);

  // --- Single LLM call (defensive: any throw → empty set) -------------------
  let raw: string;
  try {
    raw = await llm.chat({
      messages,
      json: true,
      temperature: 0,
      maxTokens: 200,
      thinkingDisabled: true,
    });
  } catch {
    return new Set();
  }

  return parseDropRefs(raw, back);
}

// ---------------------------------------------------------------------------
// Prompt construction — opaque refs only, listener context from the profile.
// ---------------------------------------------------------------------------
function buildPrompt(
  tracks: MusicTrack[],
  refs: string[],
  profile: TasteProfile,
): { role: "system" | "user" | "assistant"; content: string }[] {
  const trackList = tracks
    .map((t, i) => `- ${refs[i]}: ${t.title} — ${t.artist}`)
    .join("\n");

  const topArtists = profile.topArtists
    .slice(0, 10)
    .map((a) => a.artist)
    .filter(Boolean);
  const topTags = profile.topTags
    .slice(0, 12)
    .map((t) => t.tag)
    .filter(Boolean);

  const system =
    "You are a careful music curator. Given a listener's taste and a short list of tracks, " +
    "you identify the few that are most likely a clunker or jarring fit. " +
    "You respond ONLY with compact JSON: {\"drop\": [\"t1\", ...]} where each entry is one of the provided refs. " +
    "Pick at most 2. If unsure, pick fewer or none — never invent refs.";

  const user =
    `Listener's top artists: ${topArtists.length ? topArtists.join(", ") : "(unknown)"}\n` +
    `Listener's top tags: ${topTags.length ? topTags.join(", ") : "(unknown)"}\n\n` +
    `Tracks (ref — title — artist):\n${trackList}\n\n` +
    `Which 0–2 of these are most likely a clunker or jarring fit for this listener? ` +
    `Respond JSON {"drop": ["tN", ...]}.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---------------------------------------------------------------------------
// Response parsing — tolerate any shape the model emits; never throw.
// ---------------------------------------------------------------------------
function parseDropRefs(raw: string, back: Map<string, string>): Set<string> {
  const drops = new Set<string>();

  const obj = safeExtractDropArray(raw);
  if (!Array.isArray(obj)) return drops;

  for (const entry of obj) {
    if (drops.size >= MAX_DROPS) break; // hard cap
    if (typeof entry !== "string") continue;
    const ref = entry.trim();
    // Only accept refs we issued; ignore anything else (model hallucinations,
    // real-id parrots, numbers, etc.). Range-validated by map membership.
    const trackId = back.get(ref);
    if (!trackId) continue;
    drops.add(trackId);
  }
  return drops;
}

/**
 * Pull the `drop` array out of the LLM's raw response. Tolerates: clean JSON,
 * JSON wrapped in ```json fences, leading/trailing prose, and string-wrapped
 * payloads. Returns null on any failure — the caller treats null as "no drops".
 */
function safeExtractDropArray(raw: string): unknown[] | null {
  if (typeof raw !== "string") return null;

  // Best case: the model returned a clean JSON object.
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && Array.isArray((v as { drop?: unknown }).drop)) {
      return (v as { drop: unknown[] }).drop;
    }
  } catch {
    /* fall through to extraction */
  }

  // Fallback: scan for the first {...} block and try again. Handles both
  // ```json\n{...}\n``` fences and loose "Here you go: {...}" prose.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]);
    if (v && typeof v === "object" && Array.isArray((v as { drop?: unknown }).drop)) {
      return (v as { drop: unknown[] }).drop;
    }
  } catch {
    /* not parseable — give up */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fisher–Yates shuffle with an injectable RNG. Mutates a copy of `arr`; the
// caller's ordering (the engine's ranking) is preserved.
// ---------------------------------------------------------------------------
function shuffle<T>(arr: readonly T[], rng: Rng): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    // rng() returns [0, 1). Use Math.floor to get a valid index.
    const j = Math.floor(rng() * (i + 1));
    if (j !== i) {
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
  }
  return out;
}
