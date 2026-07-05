import { NextResponse } from 'next/server'
import { createClientForRequest } from '@/lib/supabase/server'

// ============================================================
// POST   /api/mobile/push-token — register/refresh this device's
//        Expo push token. Called on login and whenever the token
//        rotates (Expo can reissue tokens; the mobile app re-POSTs
//        on every app foreground to keep last_seen_at fresh).
// DELETE /api/mobile/push-token — unregister on logout, so a device
//        that changes hands doesn't keep receiving the old user's
//        pushes (see migration 046's UNIQUE(user_id, expo_push_token)).
//
// Mobile-only — always Bearer-authed in practice, but uses the same
// dual-mode createClientForRequest() as every other route touched for
// the mobile app, so this stays consistent if a web caller ever needs it.
// ============================================================

const VALID_PLATFORMS = new Set(['ios', 'android'])

export async function POST(request: Request) {
  try {
    const { supabase, bearerToken } = await createClientForRequest(request)

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(bearerToken)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json().catch(() => null)
    const expoPushToken = body?.expo_push_token
    const platform = body?.platform

    if (typeof expoPushToken !== 'string' || !expoPushToken) {
      return NextResponse.json({ error: 'expo_push_token is required' }, { status: 400 })
    }
    if (!VALID_PLATFORMS.has(platform)) {
      return NextResponse.json({ error: "platform must be 'ios' or 'android'" }, { status: 400 })
    }

    const { error: upsertError } = await supabase
      .from('push_device_tokens')
      .upsert(
        {
          user_id: user.id,
          account_id: accountId,
          expo_push_token: expoPushToken,
          platform,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,expo_push_token' },
      )

    if (upsertError) {
      console.error('[push-token] upsert failed:', upsertError.message)
      return NextResponse.json({ error: 'Failed to register device token' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[push-token] POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, bearerToken } = await createClientForRequest(request)

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(bearerToken)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const expoPushToken = body?.expo_push_token

    let query = supabase.from('push_device_tokens').delete().eq('user_id', user.id)
    if (typeof expoPushToken === 'string' && expoPushToken) {
      query = query.eq('expo_push_token', expoPushToken)
    }
    const { error: deleteError } = await query

    if (deleteError) {
      console.error('[push-token] delete failed:', deleteError.message)
      return NextResponse.json({ error: 'Failed to unregister device token' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[push-token] DELETE error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
