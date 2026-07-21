import type { SupabaseClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
  type MetaPhoneInfo,
} from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'

// Extracted from POST /api/whatsapp/config so the same
// verify -> encrypt -> register -> subscribe -> persist pipeline can be
// driven either by the manual-entry form or by the embedded signup
// exchange route (src/app/api/whatsapp/embedded-signup/route.ts)
// without duplicating the Meta call sequence.

export interface SaveWhatsappConfigArgs {
  accountId: string
  userId: string
  phoneNumberId: string
  wabaId?: string | null
  accessToken: string
  verifyToken?: string | null
  pin?: string | null
  // Optional override for Meta's app-scoped Resumable Upload API
  // (profile photo, template header images). NULL/omitted falls back
  // to the server's META_APP_ID env var — only needed when this
  // account's access token was issued by a different Meta App than
  // that default (see migration 056).
  appId?: string | null
}

export type SaveWhatsappConfigResult =
  | {
      ok: true
      success: true
      saved: true
      registered: boolean
      registrationSkipped: boolean
      phoneInfo: MetaPhoneInfo
    }
  | {
      ok: true
      success: false
      saved: true
      registered: false
      registrationError: string
      phoneInfo: MetaPhoneInfo
    }
  | { ok: false; status: number; error: string }

export async function saveWhatsappConfig(
  supabase: SupabaseClient,
  supabaseAdmin: SupabaseClient,
  args: SaveWhatsappConfigArgs,
): Promise<SaveWhatsappConfigResult> {
  const { accountId, userId, phoneNumberId, wabaId, accessToken, verifyToken, pin, appId } = args

  if (pin !== undefined && pin !== null && pin !== '') {
    if (!/^\d{6}$/.test(pin)) {
      return { ok: false, status: 400, error: 'PIN must be exactly 6 digits.' }
    }
  }

  // Reject if another account has already claimed this phone_number_id
  // (see route.ts's POST handler for the full rationale — issue #136).
  const { data: claimed, error: claimedError } = await supabaseAdmin
    .from('whatsapp_config')
    .select('account_id')
    .eq('phone_number_id', phoneNumberId)
    .neq('account_id', accountId)
    .maybeSingle()

  if (claimedError) {
    console.error('Error checking phone_number_id ownership:', claimedError)
    return { ok: false, status: 500, error: 'Failed to validate configuration' }
  }
  if (claimed) {
    return {
      ok: false,
      status: 409,
      error:
        'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
    }
  }

  let phoneInfo: MetaPhoneInfo
  try {
    phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    console.error('Meta API verification failed during save:', message)
    return { ok: false, status: 400, error: `Meta API error: ${message}` }
  }

  let encryptedAccessToken: string
  let encryptedVerifyToken: string | null
  try {
    encryptedAccessToken = encrypt(accessToken)
    encryptedVerifyToken = verifyToken ? encrypt(verifyToken) : null
  } catch (err) {
    console.error('Encryption failed:', err instanceof Error ? err.message : err)
    return {
      ok: false,
      status: 500,
      error:
        'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
    }
  }

  const { data: existing } = await supabase
    .from('whatsapp_config')
    .select('id, registered_at, phone_number_id')
    .eq('account_id', accountId)
    .maybeSingle()

  const sameNumber =
    existing?.phone_number_id === phoneNumberId && existing?.registered_at != null

  let registeredAt: string | null = existing?.registered_at ?? null
  let registrationError: string | null = null
  let registrationSkipped = false

  const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
  if (needsRegistration) {
    if (!pin) {
      // See route.ts POST handler: Meta TEST numbers expose no PIN, so
      // this is a best-effort step, not a hard requirement.
      registrationSkipped = true
    } else {
      try {
        await registerPhoneNumber({ phoneNumberId, accessToken, pin })
        registeredAt = new Date().toISOString()
      } catch (err) {
        registrationError = err instanceof Error ? err.message : 'Unknown Meta API error'
        console.error('Phone number /register failed:', registrationError)
      }
    }
  }

  let subscribedAppsAt: string | null = null
  if (wabaId) {
    try {
      await subscribeWabaToApp({ wabaId, accessToken })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      console.warn(
        'WABA subscribed_apps failed (non-fatal):',
        err instanceof Error ? err.message : err,
      )
    }
  }

  const baseRow = {
    phone_number_id: phoneNumberId,
    waba_id: wabaId || null,
    app_id: appId || null,
    access_token: encryptedAccessToken,
    verify_token: encryptedVerifyToken,
    status: registrationError ? 'disconnected' : 'connected',
    connected_at: registrationError ? null : new Date().toISOString(),
    registered_at: registrationError ? null : registeredAt,
    subscribed_apps_at: subscribedAppsAt ?? null,
    last_registration_error: registrationError,
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from('whatsapp_config')
      .update(baseRow)
      .eq('account_id', accountId)
    if (updateError) {
      console.error('Error updating whatsapp_config:', updateError)
      return { ok: false, status: 500, error: 'Failed to update configuration' }
    }
  } else {
    const { error: insertError } = await supabase
      .from('whatsapp_config')
      .insert({ account_id: accountId, user_id: userId, ...baseRow })
    if (insertError) {
      console.error('Error inserting whatsapp_config:', insertError)
      return { ok: false, status: 500, error: 'Failed to save configuration' }
    }
  }

  if (registrationError) {
    return {
      ok: true,
      success: false,
      saved: true,
      registered: false,
      registrationError,
      phoneInfo,
    }
  }

  return {
    ok: true,
    success: true,
    saved: true,
    registered: registeredAt != null,
    registrationSkipped,
    phoneInfo,
  }
}
