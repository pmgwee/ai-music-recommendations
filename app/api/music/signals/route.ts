import { NextResponse } from "next/server";
import { resolveSp0DevContext } from "@/lib/music/sp0-dev";

/**
 * SP-0 SC3 proof — record a behavioural signal (skip | complete) through the
 * broad TrackStore seam. The player emits skip (abandoned inside the first
 * 30s) and complete (natural ENDED) via its `onSignal` prop; the provider wires
 * that to this route. Manual Skip/Complete buttons on the proof page also POST
 * here for UAT probing. See `lib/music/sp0-dev.ts` for the SP-0 dev-mode
 * concession.
 */
export async function POST(req: Request) {
  const ctx = resolveSp0DevContext();
  if (ctx instanceof NextResponse) return ctx;
  const { devUserId, trackStore } = ctx;

  let body: { trackId?: string; signal?: "skip" | "complete" };
  try {
    body = (await req.json()) as { trackId?: string; signal?: "skip" | "complete" };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { trackId, signal } = body;
  if (!trackId) {
    return NextResponse.json({ error: "missing trackId" }, { status: 400 });
  }
  if (signal !== "skip" && signal !== "complete") {
    return NextResponse.json({ error: "signal must be 'skip' or 'complete'" }, { status: 400 });
  }

  await trackStore.recordSignal(devUserId, trackId, signal);
  return NextResponse.json({ ok: true });
}
