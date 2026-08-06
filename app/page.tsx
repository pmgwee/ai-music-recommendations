import { redirect } from "next/navigation";

/**
 * Public root. With SP-1 the proof surface graduated into the authed dashboard
 * at `/(app)/dashboard`; this root is now a server-side redirect to it. The
 * middleware then routes unsigned visitors to `/login`, so this page never
 * renders a UI that would 401 on the (auth-protected) shelf fetch.
 *
 * SP-1 Task 3 will replace this with the real marketing landing — until then
 * it stays outside the `(app)` group (no player/auth overhead on the public
 * surface) and a pure redirect.
 */
export default function Home() {
  redirect("/dashboard");
}
