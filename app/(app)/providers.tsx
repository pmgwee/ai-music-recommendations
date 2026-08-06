"use client";

/**
 * Client provider tree for the authed `(app)` route group. The group's layout
 * (`app/(app)/layout.tsx`) is a server component (it queries the session for
 * the header + a defense-in-depth redirect), but `<YoutubePlayerProvider>`'s
 * `onTrackStart` / `onSignal` callbacks fire `fetch` from the browser. The
 * App-Router-idiomatic split — matching the subscription-agent's
 * `app/providers.tsx` pattern — is to mount the player provider from this thin
 * client wrapper, so the callbacks live client-side while the layout itself
 * stays a server component.
 *
 * Mounting the player HERE (not at the root `app/layout.tsx`) is deliberate:
 * the public surface (`/`, `/login`, `/signup`, `/auth/callback`) never pays
 * the IFrame API / portal bootstrap cost, and the persistent iframe trully
 * lives "at the layout root of the authed shell" — it survives navigation
 * between `(app)` routes but is torn down on sign-out.
 *
 * Wiring (unchanged from SP-0):
 *   onTrackStart → POST /api/music/plays     (record a play through TrackStore)
 *   onSignal     → POST /api/music/signals   (record skip/complete through TrackStore)
 */
import type { ReactNode } from "react";
import {
  YoutubePlayerProvider,
  type PlayerSignal,
} from "@/lib/providers/player-youtube";
import type { MusicTrack } from "@music-ai/engine";

async function postJSON(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Best-effort: playback must never block on a network blip. The engine
    // records nothing synchronously — a missed post simply means one signal
    // didn't land, not a broken session.
  }
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <YoutubePlayerProvider
      onTrackStart={(track: MusicTrack) =>
        postJSON("/api/music/plays", { track })
      }
      onSignal={(trackId: string, signal: PlayerSignal) =>
        postJSON("/api/music/signals", { trackId, signal })
      }
    >
      {children}
    </YoutubePlayerProvider>
  );
}
