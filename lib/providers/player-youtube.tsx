"use client";

/**
 * Task 12 — YouTube IFrame `PlayerProvider` (the app-side impl of the engine's
 * `PlayerProvider` seam).
 *
 * Ported from subscription-agent's `features/dashboard/music/use-yt-player.ts`
 * + `player-context.tsx`, adapted to:
 *   - expose the engine's `PlayerProvider` interface (`load/play/pause/next/
 *     seek/setVolume` + `state$` Observable);
 *   - resolve a track's YouTube id via `track.sources.youtube`, with a
 *     load-bearing no-op guard when that field is absent (the SC2 runtime
 *     guarantee — a source-neutral track must never crash playback);
 *   - decouple signal/recordPlay/radio-continuation from the network routes the
 *     source hardcoded (`/api/yt/signals`, `/api/yt/plays`, `/api/yt/radio`)
 *     into optional callback props, so this module is framework/engine-only and
 *     the app wires its own routes in Task 14.
 *
 * SP-0 simplification (flagged): volume persistence is local-only (localStorage
 * default 50), not the per-user `music_settings` route the source uses. Task 14
 * can promote this without touching the seam contract.
 *
 * Behaviour preserved from the source:
 *   - lazy IFrame API bootstrap (`onYouTubeIframeAPIReady` + poll fallback);
 *   - the never-reparent portal — the iframe lives in ONE fixed container that
 *     is mounted once and never unmounted/reparented (moving an iframe in the
 *     DOM reloads it, killing both the media and the YT postMessage link). The
 *     portal is parked off-screen when there's no dock slot; rect-tracked over
 *     the slot when one is registered via `registerSlot`;
 *   - auto-skip on unplayable (embed-blocked 101/150, removed/private 100,
 *     invalid id 2/5) and auto-advance on ENDED;
 *   - volume get/set + mute, with a slow-cadence mirror so changes made via
 *     YouTube's own UI propagate to React state (and persist);
 *   - position/duration reporting via a 1s poll while playing;
 *   - the `onTrackStart` signal hook used by the app to fire `recordPlay`, and
 *     skip/complete signal hooks used to fire `recordSignal`.
 */
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MusicTrack, Observable, PlayerProvider } from "@music-ai/engine";
import type { YTPlayer, YTPlayerOptions } from "@/types/youtube";

// ---------------------------------------------------------------------------
// IFrame API bootstrap
// ---------------------------------------------------------------------------

const API_SRC = "https://www.youtube.com/iframe_api";

/** Load the IFrame API once and resolve when `window.YT.Player` is available. */
function loadAPI(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return;
    if (window.YT?.Player) return resolve();
    if (!document.getElementById("yt-iframe-api")) {
      const tag = document.createElement("script");
      tag.id = "yt-iframe-api";
      tag.src = API_SRC;
      document.head.appendChild(tag);
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    // Poll fallback in case the global callback was already taken by a prior
    // caller (the API only fires the global once).
    const id = window.setInterval(() => {
      if (window.YT?.Player) {
        window.clearInterval(id);
        resolve();
      }
    }, 200);
  });
}

// ---------------------------------------------------------------------------
// Volume persistence (SP-0: local-only)
// ---------------------------------------------------------------------------

const VOLUME_KEY = "ai-music:player-volume";
const DEFAULT_VOLUME = 50;

function loadSavedVolume(): number {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (raw == null) return DEFAULT_VOLUME;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > 100) return DEFAULT_VOLUME;
    return Math.round(v);
  } catch {
    return DEFAULT_VOLUME;
  }
}

function persistVolume(v: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    /* best-effort: storage may be unavailable (private mode, sandbox) */
  }
}

// ---------------------------------------------------------------------------
// Player state + signal types
// ---------------------------------------------------------------------------

/** The state surface exposed through `state$`. Mirrors the seam's contract. */
export type PlayerStateSnapshot = {
  current: MusicTrack | null;
  isPlaying: boolean;
  position: number;
  duration: number;
};

export type PlayerSignal = "skip" | "complete";

/**
 * The full controller surface returned by `usePlayer()`. Extends the engine's
 * `PlayerProvider` seam with the methods React consumers need (queue
 * management, dock slot registration, mute, etc.) — the seam mandates a minimum
 * shape; extra methods are fine.
 */
export interface YoutubePlayerHandle extends PlayerProvider {
  // --- queue + transport extras (outside the seam) ---
  /** Replace the queue and start playing at index `i`. */
  playQueue(tracks: MusicTrack[], i: number): Promise<void>;
  /** Dock the video into `el`'s rect, or park it off-screen (null). */
  registerSlot(el: HTMLElement | null): void;
  /** Stop playback, clear the queue, hide the portal. */
  stop(): void;
  /** Toggle play/pause. */
  toggle(): void;
  /** Mute/unmute. */
  toggleMute(): void;
  /** Jump to the previous track in the queue. */
  prev(): void;

  // --- convenience state mirrors (consumed by React UIs) ---
  volume: number;
  muted: boolean;
  queueLength: number;
  hasPrev: boolean;
  hasNext: boolean;
  playerReady: boolean;
}

// ---------------------------------------------------------------------------
// Provider props
// ---------------------------------------------------------------------------

export interface YoutubePlayerProviderProps {
  children: ReactNode;
  /**
   * Fired once per track on first real playback (PLAYING after load). The app
   * uses this to call `recordPlay`.
   */
  onTrackStart?: (track: MusicTrack) => void;
  /**
   * Fired when the user abandons a track within 30s (skip) or when it reaches
   * natural end (complete). `fromTrackId` is the previous track — the "from"
   * half of a transition. The app uses this to call `recordSignal`.
   */
  onSignal?: (
    trackId: string,
    signal: PlayerSignal,
    fromTrackId: string | null,
  ) => void;
  /**
   * Called when the queue runs out (the user pressed next, or ENDED fired, at
   * the tail). If it resolves to a non-empty array, those tracks are appended
   * and playback continues into them — the source repo's "endless autoplay".
   * If omitted, playback stops at the tail.
   */
  onExtendQueue?: (seed: MusicTrack) => Promise<MusicTrack[]>;
}

// ---------------------------------------------------------------------------
// The hook (ports use-yt-player.ts)
// ---------------------------------------------------------------------------

/**
 * Queue-driven YouTube IFrame player. See the file header for the design.
 *
 * @param onTrackStart see props
 * @param onSignal see props
 * @param onExtendQueue see props
 * @param portalRef the fixed container (rendered by the provider) the iframe is
 *   created inside and never leaves.
 */
function useYoutubePlayer(
  onTrackStart: YoutubePlayerProviderProps["onTrackStart"],
  onSignal: YoutubePlayerProviderProps["onSignal"],
  onExtendQueue: YoutubePlayerProviderProps["onExtendQueue"],
  portalRef: React.RefObject<HTMLDivElement | null>,
): YoutubePlayerHandle {
  const [current, setCurrent] = useState<MusicTrack | null>(null);
  const [index, setIndex] = useState(-1);
  const [queueLength, setQueueLength] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [muted, setMuted] = useState(false);

  // Which on-screen slot the video is docked into (the dashboard card), or null
  // when there's no slot on this route (parked off-screen, audio-only).
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const slotElRef = useRef<HTMLElement | null>(null);
  slotElRef.current = slotEl;

  // The stable "stage" div handed to `new YT.Player()`. Created once; the API
  // replaces it with an <iframe> that then lives inside the portal forever.
  const stageEl = useMemo<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.createElement("div");
  }, []);

  const playerRef = useRef<YTPlayer | null>(null);
  const creatingRef = useRef<Promise<YTPlayer> | null>(null);
  const queueRef = useRef<MusicTrack[]>([]);
  const indexRef = useRef(-1);
  const loggedIdRef = useRef<string | null>(null);

  // Latest-closure refs — the player's event handlers are bound once and must
  // reach the latest props/state through refs rather than capturing a stale one.
  const onTrackStartRef = useRef(onTrackStart);
  onTrackStartRef.current = onTrackStart;
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;
  const onExtendQueueRef = useRef(onExtendQueue);
  onExtendQueueRef.current = onExtendQueue;

  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Whether the portal should be shown (a track is loaded) vs. hidden.
  const hasVideoRef = useRef(false);
  hasVideoRef.current = playerReady && current !== null;

  // --- Autoplay + behavioural signals --------------------------------------
  const extendingRef = useRef(false);
  // Wall-clock ms when the current track started, for skip detection.
  const startedAtRef = useRef(0);
  // The track that handed off to the current one — the "from" half of a
  // transition, which is what the learned sequencing model is keyed on.
  const previousIdRef = useRef<string | null>(null);
  // Set when a track reached its natural end, so the outgoing-track check
  // doesn't also report it as a skip.
  const completedRef = useRef(false);

  // --- state$ Observable bridge --------------------------------------------
  const subscribersRef = useRef<Set<(s: PlayerStateSnapshot) => void>>(
    new Set(),
  );
  const snapshotRef = useRef<PlayerStateSnapshot>({
    current: null,
    isPlaying: false,
    position: 0,
    duration: 0,
  });
  // Mirror React state into the Observable whenever any slice changes.
  useEffect(() => {
    const next: PlayerStateSnapshot = {
      current,
      isPlaying,
      position,
      duration,
    };
    snapshotRef.current = next;
    for (const cb of subscribersRef.current) cb(next);
  }, [current, isPlaying, position, duration]);

  const state$ = useMemo<Observable<PlayerStateSnapshot>>(
    () => ({
      subscribe: (cb) => {
        subscribersRef.current.add(cb);
        // Emit the current snapshot immediately so a fresh subscriber doesn't
        // see a stale blank until the next state change.
        cb(snapshotRef.current);
        return () => {
          subscribersRef.current.delete(cb);
        };
      },
    }),
    [],
  );

  // --- Bootstrap the IFrame API on mount so the first play can create the
  //     player within the click gesture (keeps autoplay allowed).
  useEffect(() => {
    void loadAPI();
  }, []);

  // Home the stage inside the fixed portal once. It (and the iframe the API
  // swaps in) never leaves — only the portal's CSS position changes.
  useEffect(() => {
    if (!stageEl || !portalRef?.current) return;
    if (stageEl.parentElement !== portalRef.current) {
      portalRef.current.appendChild(stageEl);
    }
  }, [stageEl, portalRef]);

  // Re-hydrate the saved volume on mount (default 50 until it arrives).
  useEffect(() => {
    const v = loadSavedVolume();
    setVolumeState(v);
    applyVolume(v, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Push current volume/mute to the live player (no-op before it exists). */
  const applyVolume = useCallback((v: number, mute: boolean) => {
    const p = playerRef.current;
    if (!p) return;
    if (mute) p.mute();
    else {
      p.unMute();
      p.setVolume(v);
    }
  }, []);

  /**
   * Glue the fixed portal over the docked slot's rect (so the video looks
   * inline in the card), or park it off-screen when there's no slot. Never
   * touches the DOM tree — only inline styles — so the iframe is never reloaded.
   */
  const positionPortal = useCallback(() => {
    const portal = portalRef?.current;
    if (!portal) return;
    const slot = slotElRef.current;
    if (slot) {
      const r = slot.getBoundingClientRect();
      const show = hasVideoRef.current;
      portal.style.top = `${r.top}px`;
      portal.style.left = `${r.left}px`;
      portal.style.width = `${r.width}px`;
      portal.style.height = `${r.height}px`;
      portal.style.borderRadius = window.getComputedStyle(slot).borderRadius;
      portal.style.opacity = show ? "1" : "0";
      portal.style.pointerEvents = show ? "auto" : "none";
    } else {
      // Parked: kept at real size, off-screen, so playback never pauses.
      portal.style.top = "0px";
      portal.style.left = "-10000px";
      portal.style.width = "320px";
      portal.style.height = "180px";
      portal.style.opacity = "0";
      portal.style.pointerEvents = "none";
    }
  }, [portalRef]);

  // While docked, follow the slot every frame (scroll, resize, layout shifts).
  // While parked, position once. Cheap: just sets styles. Guarded so jsdom
  // (which may not implement rAF) doesn't throw.
  useEffect(() => {
    positionPortal();
    if (!slotEl) return;
    if (typeof requestAnimationFrame !== "function") return;
    let raf = 0;
    const loop = () => {
      positionPortal();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [slotEl, positionPortal]);

  /** Dock the video into `el` (dashboard slot) or park it off-screen (null). */
  const registerSlot = useCallback((el: HTMLElement | null) => setSlotEl(el), []);

  /** Fire-and-forget signal to the app layer (skip / complete). */
  const emitSignal = useCallback(
    (trackId: string, signal: PlayerSignal, from: string | null) => {
      onSignalRef.current?.(trackId, signal, from);
    },
    [],
  );

  /**
   * Judge the track we're leaving. Abandoning inside the first 30 seconds is
   * the strongest negative signal both Spotify and Apple Music record, so it's
   * the threshold we use too. A track that ended naturally is handled by the
   * ENDED branch and flagged here so it isn't double-counted.
   */
  const settleOutgoing = useCallback(() => {
    if (completedRef.current) {
      completedRef.current = false;
      return;
    }
    const outgoing = queueRef.current[indexRef.current];
    if (!outgoing || !startedAtRef.current) return;
    const playedMs = Date.now() - startedAtRef.current;
    if (playedMs < 30_000) {
      emitSignal(outgoing.trackId, "skip", previousIdRef.current);
    }
  }, [emitSignal]);

  const playIndex = useCallback(
    (i: number) => {
      const track = queueRef.current[i];
      const player = playerRef.current;
      if (!track || !player) return;
      settleOutgoing();
      previousIdRef.current = queueRef.current[indexRef.current]?.trackId ?? null;
      indexRef.current = i;
      setIndex(i);
      setCurrent(track);
      setPosition(0);
      startedAtRef.current = 0;
      // The load-bearing resolution: a track's YouTube id lives at
      // `track.sources.youtube`. The SC2 guard at the public `load()` boundary
      // ensures this is defined here; `playQueue` trusts its caller.
      player.loadVideoById(track.sources.youtube!);
    },
    [settleOutgoing],
  );

  const skip = useCallback(
    (delta: number) => {
      const next = indexRef.current + delta;
      if (next >= 0 && next < queueRef.current.length) playIndex(next);
    },
    [playIndex],
  );

  /**
   * Endless autoplay: top the queue up via the app's `onExtendQueue` callback
   * (the source's /api/yt/radio route) rather than stopping. Returns true when
   * tracks were appended.
   */
  const extendQueue = useCallback(async (): Promise<boolean> => {
    if (extendingRef.current) return false;
    const seedTrack = queueRef.current[indexRef.current];
    if (!seedTrack) return false;
    const extend = onExtendQueueRef.current;
    if (!extend) return false;

    extendingRef.current = true;
    try {
      const tracks = await extend(seedTrack);
      if (!tracks?.length) return false;
      queueRef.current = [...queueRef.current, ...tracks];
      setQueueLength(queueRef.current.length);
      return true;
    } catch {
      return false;
    } finally {
      extendingRef.current = false;
    }
  }, []);

  // Latest-closure refs for callbacks used inside the once-created player.
  const extendQueueRef = useRef(extendQueue);
  extendQueueRef.current = extendQueue;
  const emitSignalRef = useRef(emitSignal);
  emitSignalRef.current = emitSignal;
  const skipRef = useRef(skip);
  skipRef.current = skip;

  /**
   * Create the player on demand, once. `firstVideoId` is loaded straight into
   * the constructor so YouTube never renders its sticky empty-player error
   * screen.
   */
  const ensurePlayer = useCallback(
    (firstVideoId?: string): Promise<YTPlayer> => {
      if (playerRef.current) return Promise.resolve(playerRef.current);
      if (creatingRef.current) return creatingRef.current;

      creatingRef.current = loadAPI().then(
        () =>
          new Promise<YTPlayer>((resolve) => {
            const YT = window.YT!;
            const player = new YT.Player(stageEl!, {
              width: "100%",
              height: "100%",
              videoId: firstVideoId,
              playerVars: {
                autoplay: 1,
                controls: 1,
                playsinline: 1,
                rel: 0,
                modestbranding: 1,
              },
              events: {
                onReady: () => {
                  playerRef.current = player;
                  applyVolume(volumeRef.current, mutedRef.current);
                  setPlayerReady(true);
                  resolve(player);
                },
                onStateChange: (e) => {
                  const state = window.YT!.PlayerState;
                  if (e.data === state.PLAYING) {
                    setIsPlaying(true);
                    setDuration(e.target.getDuration() || 0);
                    // Log each loaded track once, on first real playback.
                    const track = queueRef.current[indexRef.current];
                    if (track && loggedIdRef.current !== track.trackId) {
                      loggedIdRef.current = track.trackId;
                      startedAtRef.current = Date.now();
                      onTrackStartRef.current?.(track);
                    }
                  } else if (e.data === state.PAUSED) {
                    setIsPlaying(false);
                  } else if (e.data === state.BUFFERING) {
                    setIsPlaying(true);
                  } else if (e.data === state.ENDED) {
                    setIsPlaying(false);
                    // A natural end is the passive positive signal, and it also
                    // tells the transition model that this hand-off worked.
                    const finished = queueRef.current[indexRef.current];
                    if (finished) {
                      completedRef.current = true;
                      emitSignalRef.current(
                        finished.trackId,
                        "complete",
                        previousIdRef.current,
                      );
                    }
                    // At the tail of the queue, extend the station instead of
                    // stopping — this is what makes playback endless. If no
                    // `onExtendQueue` was wired, `extendQueue` no-ops and we
                    // simply stop (graceful degradation).
                    if (indexRef.current >= queueRef.current.length - 1) {
                      void extendQueueRef.current().then((extended) => {
                        if (extended) skipRef.current(1);
                      });
                    } else {
                      skipRef.current(1);
                    }
                  }
                },
                onError: (e) => {
                  // 2/5 invalid, 100 removed/private, 101/150 embed blocked.
                  if ([2, 5, 100, 101, 150].includes(e.data)) skipRef.current(1);
                },
              },
            } as YTPlayerOptions);
          }),
      );
      return creatingRef.current;
    },
    [stageEl, applyVolume],
  );

  /** Replace the queue and start playing at `i`. */
  const playQueue = useCallback(
    async (tracks: MusicTrack[], i: number) => {
      queueRef.current = tracks;
      setQueueLength(tracks.length);
      // A new queue starts a new station: drop the transition history so we
      // don't attribute a hand-off across queues.
      previousIdRef.current = null;
      completedRef.current = false;
      startedAtRef.current = 0;
      const track = tracks[i];
      const created = !playerRef.current && !creatingRef.current;
      // Seed the very first player with the target video so YouTube skips its
      // empty-player error screen. Later plays reuse the existing player.
      await ensurePlayer(track?.sources.youtube);
      if (created && track) {
        // The constructor already loaded (and autoplays) this track — sync our
        // state so the UI reflects it without a redundant reload.
        indexRef.current = i;
        setIndex(i);
        setCurrent(track);
        setPosition(0);
        loggedIdRef.current = null;
      } else {
        playIndex(i);
      }
    },
    [ensurePlayer, playIndex],
  );

  // ---------------------- PlayerProvider seam impl -------------------------

  /**
   * Load a single track. The load-bearing SC2 guard: a track with no
   * `sources.youtube` is a no-op, never a throw. When a YouTube id IS present,
   * this replaces the queue with `[track]` and starts it.
   */
  const load = useCallback(
    async (track: MusicTrack): Promise<void> => {
      const yt = track.sources.youtube;
      if (!yt) return; // SC2 runtime guarantee — source-neutral tracks are skipped.
      await playQueue([track], 0);
    },
    [playQueue],
  );

  const play = useCallback(() => {
    playerRef.current?.playVideo();
  }, []);

  const pause = useCallback(() => {
    playerRef.current?.pauseVideo();
  }, []);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying) p.pauseVideo();
    else p.playVideo();
  }, [isPlaying]);

  /** Advance one track. At the tail, tops the queue up via `onExtendQueue`
   *  (if wired); otherwise a no-op. */
  const next = useCallback(async () => {
    if (indexRef.current < queueRef.current.length - 1) {
      skip(1);
      return;
    }
    if (await extendQueue()) skip(1);
  }, [skip, extendQueue]);

  const prev = useCallback(() => skip(-1), [skip]);

  const seek = useCallback((seconds: number) => {
    playerRef.current?.seekTo(seconds, true);
  }, []);

  const setVolume = useCallback(
    (v: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(v)));
      setVolumeState(clamped);
      if (clamped === 0) {
        // Dragging to zero is treated as mute so the icon reflects silence.
        setMuted(true);
        applyVolume(0, true);
      } else {
        if (muted) setMuted(false);
        applyVolume(clamped, false);
      }
      persistVolume(clamped);
    },
    [applyVolume, muted],
  );

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const nextMuted = !m;
      applyVolume(volumeRef.current, nextMuted);
      return nextMuted;
    });
  }, [applyVolume]);

  /** Stop playback and clear the queue (hides the persistent mini-player). */
  const stop = useCallback(() => {
    const p = playerRef.current;
    if (p) p.stopVideo();
    queueRef.current = [];
    indexRef.current = -1;
    previousIdRef.current = null;
    startedAtRef.current = 0;
    setQueueLength(0);
    setCurrent(null);
    setIsPlaying(false);
    setPosition(0);
  }, []);

  // Poll playback position while playing.
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      setPosition(p.getCurrentTime() || 0);
      setDuration(p.getDuration() || 0);
    }, 1000);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  // Mirror the iframe's actual volume/mute into state on a slow cadence,
  // whenever the player exists — so changes made via YouTube's own UI propagate
  // to React state and persist. Values that match our state are skipped, so
  // there's no feedback loop with our own setVolume.
  useEffect(() => {
    if (!playerReady) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      try {
        const iv = Math.round(p.getVolume());
        if (Number.isFinite(iv) && iv >= 0 && iv <= 100 && iv !== volumeRef.current) {
          setVolumeState(iv);
          persistVolume(iv);
        }
        const im = p.isMuted();
        if (im !== mutedRef.current) setMuted(im);
      } catch {
        /* getters can be briefly unavailable right after load */
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [playerReady]);

  return {
    // PlayerProvider seam
    load,
    play,
    pause,
    next: () => void next(),
    seek,
    setVolume,
    state$,
    // extras
    playQueue,
    registerSlot,
    stop,
    toggle,
    toggleMute,
    prev,
    volume,
    muted,
    queueLength,
    hasPrev: index > 0,
    hasNext: index >= 0,
    playerReady,
  };
}

// ---------------------------------------------------------------------------
// React context + <YoutubePlayerProvider>
// ---------------------------------------------------------------------------

const YoutubePlayerContext = createContext<YoutubePlayerHandle | null>(null);

/**
 * Mounts the YouTube player ONCE. The IFrame lives inside a single
 * fixed-position "portal" that is NEVER unmounted or reparented — moving an
 * iframe in the DOM tree forces the browser to reload it (restarting the video
 * AND breaking the YT Player API postMessage link). The portal is parked
 * off-screen when no slot is registered and glued over a registered slot's rect
 * when one is (Task 14 wires the slot).
 */
export function YoutubePlayerProvider({
  children,
  onTrackStart,
  onSignal,
  onExtendQueue,
}: YoutubePlayerProviderProps) {
  // The one and only home for the live iframe. Fixed-position; its coordinates
  // are driven imperatively by the hook (docked over a slot, or off-screen).
  const portalRef = useRef<HTMLDivElement | null>(null);

  const player = useYoutubePlayer(
    onTrackStart,
    onSignal,
    onExtendQueue,
    portalRef,
  );

  return (
    <YoutubePlayerContext.Provider value={player}>
      {children}
      {/* The persistent iframe portal. Starts off-screen; the hook positions it
          over a registered slot (docked) or parks it (audio-only). Kept laid
          out — never display:none — so the browser never pauses the media. */}
      <div
        ref={portalRef}
        aria-hidden="true"
        className="yt-video-portal fixed left-[-10000px] top-0 z-20 h-[180px] w-[320px] overflow-hidden bg-black opacity-0"
      />
    </YoutubePlayerContext.Provider>
  );
}

/** Access the shared player. Must be used inside <YoutubePlayerProvider>. */
export function usePlayer(): YoutubePlayerHandle {
  const ctx = useContext(YoutubePlayerContext);
  if (!ctx)
    throw new Error("usePlayer must be used within a YoutubePlayerProvider");
  return ctx;
}
