import { NextResponse } from "next/server";
import type { MusicTrack } from "@music-ai/engine";
import { resolveSp0DevContext } from "@/lib/music/sp0-dev";

/**
 * SP-0 SC3 proof — record a play through the broad TrackStore seam. The player
 * fires `onTrackStart` once per track on first real playback (PLAYING after
 * load); the provider wires that to this route. See `lib/music/sp0-dev.ts` for
 * the SP-0 dev-mode concession.
 */
export async function POST(req: Request) {
  const ctx = resolveSp0DevContext();
  if (ctx instanceof NextResponse) return ctx;
  const { devUserId, trackStore } = ctx;

  let body: { track?: MusicTrack };
  try {
    body = (await req.json()) as { track?: MusicTrack };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const track = body?.track;
  if (!track?.trackId) {
    return NextResponse.json({ error: "missing track.trackId" }, { status: 400 });
  }

  await trackStore.recordPlay(devUserId, track);
  return NextResponse.json({ ok: true });
}
