// @vitest-environment jsdom
/**
 * Task 12 — YouTube IFrame PlayerProvider.
 *
 * Renders <YoutubePlayerProvider> in jsdom (no real IFrame, no network) and
 * verifies:
 *   1. `usePlayer()` returns a controller satisfying the `PlayerProvider` seam
 *      (load/play/pause/next/seek/setVolume/state$).
 *   2. `state$` is an Observable per the seam definition — subscribe returns an
 *      unsubscribe fn and pushes the current snapshot immediately.
 *   3. `load(track)` resolves `track.sources.youtube` and wires it into the YT
 *      player (constructor `videoId` on first load; `loadVideoById` thereafter).
 *   4. The load-bearing SC2 guard: a track with NO `sources.youtube` is a
 *      silent no-op, never a throw, and never reaches the YT player.
 *   5. Transport methods (play/pause/seek/setVolume) are wired through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MusicTrack } from "@music-ai/engine";
import type { YTPlayerOptions } from "@/types/youtube";

import {
  YoutubePlayerProvider,
  usePlayer,
} from "./player-youtube";

// ---------------------------------------------------------------------------
// Fake YT IFrame API
// ---------------------------------------------------------------------------

class FakePlayer {
  static last: FakePlayer | null = null;
  static lastOpts: YTPlayerOptions | null = null;
  static instances: FakePlayer[] = [];

  videoId: string | undefined;
  loadVideoByIdCalls: string[] = [];
  playCalls = 0;
  pauseCalls = 0;
  stopCalls = 0;
  seekCalls: number[] = [];
  volumeSetCalls: number[] = [];
  muteCount = 0;
  unmuteCount = 0;
  private mutedState = false;
  private volumeState = 50;
  currentTime = 0;
  durationState = 200;

  constructor(el: HTMLElement | string, opts: YTPlayerOptions) {
    FakePlayer.last = this;
    FakePlayer.lastOpts = opts;
    FakePlayer.instances.push(this);
    this.videoId = opts.videoId;
    // Defer onReady so the impl's `const player = new YT.Player(...)` finishes
    // assigning before any callback fires — mirrors real YT, which fires
    // onReady after the iframe loads, and avoids the TDZ on the captured
    // `player` binding.
    setTimeout(() => {
      opts.events?.onReady?.({ target: this });
    }, 0);
  }
  loadVideoById(id: string) {
    this.videoId = id;
    this.loadVideoByIdCalls.push(id);
  }
  cueVideoById(_id: string) {
    /* unused by the impl — present to satisfy the YTPlayer type */
  }
  nextVideo() {
    /* unused — present to satisfy the YTPlayer type */
  }
  previousVideo() {
    /* unused — present to satisfy the YTPlayer type */
  }
  playVideo() {
    this.playCalls++;
  }
  pauseVideo() {
    this.pauseCalls++;
  }
  stopVideo() {
    this.stopCalls++;
  }
  seekTo(s: number) {
    this.seekCalls.push(s);
  }
  getCurrentTime() {
    return this.currentTime;
  }
  getDuration() {
    return this.durationState;
  }
  getPlayerState() {
    return 1;
  }
  getVolume() {
    return this.volumeState;
  }
  setVolume(v: number) {
    this.volumeSetCalls.push(v);
    this.volumeState = v;
  }
  mute() {
    this.muteCount++;
    this.mutedState = true;
  }
  unMute() {
    this.unmuteCount++;
    this.mutedState = false;
  }
  isMuted() {
    return this.mutedState;
  }
  getIframe() {
    return {} as HTMLIFrameElement;
  }
  destroy() {}
}

function installYT() {
  (window as unknown as { YT: unknown }).YT = {
    Player: FakePlayer,
    PlayerState: {
      UNSTARTED: -1,
      ENDED: 0,
      PLAYING: 1,
      PAUSED: 2,
      BUFFERING: 3,
      CUED: 5,
    },
  };
}

function clearYT() {
  delete (window as unknown as { YT?: unknown }).YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown })
    .onYouTubeIframeAPIReady;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: ReactNode }) {
  return <YoutubePlayerProvider>{children}</YoutubePlayerProvider>;
}

const trackWithYT: MusicTrack = {
  trackId: "yt:dQw4w9WgXcQ",
  sources: { youtube: "dQw4w9WgXcQ" },
  title: "Never Gonna Give You Up",
  artist: "Rick Astley",
  thumbnail: "https://img.example/rick.jpg",
};

const secondYT: MusicTrack = {
  trackId: "yt:M7lc1UVf-VE",
  sources: { youtube: "M7lc1UVf-VE" },
  title: "Other Track",
  artist: "Other Artist",
  thumbnail: null,
};

const sourceNeutral: MusicTrack = {
  trackId: "yt:no-yt-source",
  sources: {}, // SC2: no YouTube id.
  title: "Source-neutral",
  artist: "Unknown",
  thumbnail: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("YoutubePlayerProvider", () => {
  beforeEach(() => {
    installYT();
    FakePlayer.last = null;
    FakePlayer.lastOpts = null;
    FakePlayer.instances = [];
    window.localStorage.clear();
  });
  afterEach(() => {
    clearYT();
    vi.useRealTimers();
  });

  it("usePlayer() returns a controller satisfying the PlayerProvider seam", () => {
    const { result } = renderHook(() => usePlayer(), { wrapper });

    const handle = result.current;
    expect(typeof handle.load).toBe("function");
    expect(typeof handle.play).toBe("function");
    expect(typeof handle.pause).toBe("function");
    expect(typeof handle.next).toBe("function");
    expect(typeof handle.seek).toBe("function");
    expect(typeof handle.setVolume).toBe("function");
    expect(handle.state$).toBeDefined();
    expect(typeof handle.state$.subscribe).toBe("function");
  });

  it("state$ is an Observable: pushes the current snapshot and unsubscribes", () => {
    const { result } = renderHook(() => usePlayer(), { wrapper });

    const seen: {
      current: MusicTrack | null;
      isPlaying: boolean;
      position: number;
      duration: number;
    }[] = [];
    const unsub = result.current.state$.subscribe((s) => seen.push(s));

    expect(typeof unsub).toBe("function");
    // Immediate emission of the current snapshot (per the impl contract).
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toEqual({
      current: null,
      isPlaying: false,
      position: 0,
      duration: 0,
    });

    // After unsubscribe, no further emissions.
    const before = seen.length;
    unsub();
    // Trigger a state change — the mirror effect runs, but no callback should fire.
    act(() => {
      result.current.play();
    });
    expect(seen.length).toBe(before);
  });

  it("load(track) seeds the YT player with track.sources.youtube on first load", async () => {
    const { result } = renderHook(() => usePlayer(), { wrapper });

    await act(async () => {
      await result.current.load(trackWithYT);
    });

    // First load constructs the player with the videoId in the constructor
    // (so YouTube skips its empty-player error screen — see impl comment).
    await waitFor(() => expect(FakePlayer.lastOpts).toBeTruthy());
    expect(FakePlayer.lastOpts!.videoId).toBe("dQw4w9WgXcQ");
  });

  it("load(track) calls loadVideoById when the player already exists", async () => {
    const { result } = renderHook(() => usePlayer(), { wrapper });

    // First load creates the player.
    await act(async () => {
      await result.current.load(trackWithYT);
    });
    const player = FakePlayer.last!;
    expect(player).toBeTruthy();

    // Second load reuses the player and goes through loadVideoById.
    await act(async () => {
      await result.current.load(secondYT);
    });
    expect(player.loadVideoByIdCalls).toContain("M7lc1UVf-VE");
  });

  it("SC2 guard: load(track) with no sources.youtube is a silent no-op", async () => {
    const { result } = renderHook(() => usePlayer(), { wrapper });

    // First, seed the player with a real track so we have a baseline.
    await act(async () => {
      await result.current.load(trackWithYT);
    });
    const player = FakePlayer.last!;
    const baselineLoadCalls = player.loadVideoByIdCalls.length;
    const baselineVideoId = player.videoId;

    // Now load a source-neutral track. Must not throw, must not call
    // loadVideoById, must not change the underlying videoId.
    await expect(
      act(async () => {
        await result.current.load(sourceNeutral);
      }),
    ).resolves.toBeUndefined();

    expect(player.loadVideoByIdCalls.length).toBe(baselineLoadCalls);
    expect(player.videoId).toBe(baselineVideoId);
  });

  it("transport methods wire through to the YT player", async () => {
    const { result } = renderHook(() => usePlayer(), { wrapper });

    await act(async () => {
      await result.current.load(trackWithYT);
    });
    const player = FakePlayer.last!;

    act(() => result.current.play());
    expect(player.playCalls).toBe(1);

    act(() => result.current.pause());
    expect(player.pauseCalls).toBe(1);

    act(() => result.current.seek(42));
    expect(player.seekCalls).toContain(42);

    act(() => result.current.setVolume(73));
    // setVolume(73) → unmute + setVolume(73) on the YT player.
    expect(player.volumeSetCalls).toContain(73);
  });

  it("setVolume clamps to [0,100] and treats 0 as mute", async () => {
    const { result } = renderHook(() => usePlayer(), { wrapper });

    await act(async () => {
      await result.current.load(trackWithYT);
    });
    const player = FakePlayer.last!;

    act(() => result.current.setVolume(999));
    expect(result.current.volume).toBe(100);

    act(() => result.current.setVolume(-5));
    expect(result.current.volume).toBe(0);
    expect(result.current.muted).toBe(true);
    expect(player.muteCount).toBeGreaterThan(0);
  });

  it("fires onTrackStart on first real playback of a loaded track", async () => {
    const onTrackStart = vi.fn();
    const localWrapper = ({ children }: { children: ReactNode }) => (
      <YoutubePlayerProvider onTrackStart={onTrackStart}>
        {children}
      </YoutubePlayerProvider>
    );
    const { result } = renderHook(() => usePlayer(), {
      wrapper: localWrapper,
    });

    await act(async () => {
      await result.current.load(trackWithYT);
    });

    // Simulate YT entering PLAYING — this is what fires onTrackStart.
    act(() => {
      const state = window.YT!.PlayerState.PLAYING;
      FakePlayer.lastOpts!.events!.onStateChange!({
        data: state,
        target: FakePlayer.last!,
      });
    });

    expect(onTrackStart).toHaveBeenCalledTimes(1);
    expect(onTrackStart).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: "yt:dQw4w9WgXcQ" }),
    );
  });
});
