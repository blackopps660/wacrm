import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  uploadResumableMedia,
  updateWhatsAppBusinessProfile,
} from '@/lib/whatsapp/meta-api'

// Same limits Meta enforces for template header images and its own
// profile-photo upload UI (JPEG/PNG, 5 MB cap via the Resumable Upload API).
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png']

/**
 * POST /api/whatsapp/config/profile/photo
 *
 * Uploads a new WhatsApp Business Profile photo. Two Meta calls:
 *   1. Resumable Upload API → media handle (app-scoped, same helper
 *      used for template header images)
 *   2. POST whatsapp_business_profile with profile_picture_handle
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profileRow } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profileRow?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, access_token, app_id')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!config) {
    return NextResponse.json(
      { error: 'No WhatsApp configuration saved yet.' },
      { status: 404 },
    )
  }

  // The Resumable Upload API is app-scoped — the app_id here must
  // belong to whichever Meta App issued this account's access token.
  // Accounts connected via a different app than the server default
  // (see migration 056) set their own app_id in Settings; everyone
  // else falls back to the server-wide env var.
  const appId = config.app_id || process.env.META_APP_ID
  if (!appId) {
    return NextResponse.json(
      {
        error:
          'No Meta App ID configured for this account. Set META_APP_ID in the environment, or enter this account’s Meta App ID in WhatsApp Settings, to upload a profile photo.',
      },
      { status: 500 },
    )
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json(
      { error: 'Stored access token cannot be decrypted. Re-save your WhatsApp configuration.' },
      { status: 500 },
    )
  }

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "'file' is required" }, { status: 400 })
  }
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: `Profile photo must be JPEG or PNG (got ${file.type || 'unknown'}).` },
      { status: 400 },
    )
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return NextResponse.json(
      { error: `Photo is ${(file.size / 1024 / 1024).toFixed(1)} MB — Meta's limit is 5 MB.` },
      { status: 400 },
    )
  }

  const bytes = new Uint8Array(await file.arrayBuffer())

  try {
    const { handle } = await uploadResumableMedia({
      appId,
      accessToken,
      fileName: file.name || (file.type === 'image/png' ? 'profile.png' : 'profile.jpg'),
      mimeType: file.type,
      bytes,
    })
    await updateWhatsAppBusinessProfile({
      phoneNumberId: config.phone_number_id,
      accessToken,
      profile: { profile_picture_handle: handle },
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
  }
}
