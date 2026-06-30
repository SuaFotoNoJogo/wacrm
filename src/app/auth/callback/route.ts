import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Handles the PKCE code exchange after Supabase sends the user back
// from an email verification or magic-link click. Supabase redirects
// to this route with ?code=XXXX (and optionally ?next=/some/path).
// We exchange the code for a session (setting the auth cookies), then
// forward the user to `next` — typically /join/<token> for invite
// flows, or /dashboard for plain signups.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Respect the x-forwarded-host header so this works behind
      // reverse proxies (Vercel, Railway, etc.) where `origin` would
      // be the internal host, not the public one.
      const forwardedHost = request.headers.get('x-forwarded-host')
      const base =
        forwardedHost ? `https://${forwardedHost}` : origin

      return NextResponse.redirect(`${base}${next}`)
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
