"use client";

/**
 * Client-side provider tree. `app/layout.tsx` is a server component (it exports
 * `metadata`), but `<YoutubePlayerProvider>`'s `onTrackStart` / `onSignal`
 * callbacks need to fire `fetch` from the browser. The App-Router-idiomatic
 * split — matching the subscription-agent's `app/providers.tsx` pattern — is to
 * mount the player provider from this thin client wrapper, so the callbacks
 * live client-side while the layout itself stays a server component.
 *
 * SP-0 proof wiring:
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
    // Best-effort: the proof surface must never block playback on a network
    // blip. The engine records nothing synchronously — a missed post simply
    // means one signal didn't land, not a broken session.
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
