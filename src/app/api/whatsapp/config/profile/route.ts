import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getWhatsAppBusinessProfile,
  updateWhatsAppBusinessProfile,
} from '@/lib/whatsapp/meta-api'

// Meta's documented field limits for the Business Profile endpoint.
const MAX_LENGTHS = {
  about: 139,
  address: 256,
  description: 512,
  email: 128,
} as const

const VERTICALS = new Set([
  'UNDEFINED', 'OTHER', 'AUTO', 'BEAUTY', 'APPAREL', 'EDU', 'ENTERTAIN',
  'EVENT_PLAN', 'FINANCE', 'GROCERY', 'GOVT', 'HOTEL', 'HEALTH',
  'NONPROFIT', 'PROF_SERVICES', 'RETAIL', 'TRAVEL', 'RESTAURANT', 'NOT_A_BIZ',
])

async function resolveConfig(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) return null

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle()
  return config
}

/**
 * GET /api/whatsapp/config/profile
 *
 * Fetches the live WhatsApp Business Profile (about, address,
 * description, email, vertical, websites, photo) straight from Meta —
 * mirrors the "Sync Profile" action on respond.io's equivalent page.
 * Nothing is cached locally; this always reflects Meta's current state.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const config = await resolveConfig(supabase, user.id)
  if (!config) {
    return NextResponse.json(
      { error: 'No WhatsApp configuration saved yet.' },
      { status: 404 },
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

  try {
    const profile = await getWhatsAppBusinessProfile({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    return NextResponse.json({ profile })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
  }
}

/**
 * PATCH /api/whatsapp/config/profile
 *
 * Pushes edited profile fields to Meta — "Save Profile". Photo uploads
 * go through the separate /photo sub-route since they need multipart
 * form-data + the Resumable Upload API.
 */
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const config = await resolveConfig(supabase, user.id)
  if (!config) {
    return NextResponse.json(
      { error: 'No WhatsApp configuration saved yet.' },
      { status: 404 },
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

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { about, address, description, email, vertical, websites } = body as Record<string, unknown>

  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    const value = (body as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.length > max) {
      return NextResponse.json(
        { error: `${field} must be ${max} characters or fewer.` },
        { status: 400 },
      )
    }
  }

  if (websites !== undefined) {
    if (!Array.isArray(websites) || websites.length > 2 || !websites.every((w) => typeof w === 'string')) {
      return NextResponse.json(
        { error: 'websites must be an array of at most 2 URLs.' },
        { status: 400 },
      )
    }
  }

  if (vertical !== undefined && vertical !== '' && !VERTICALS.has(String(vertical))) {
    return NextResponse.json({ error: 'Invalid vertical/category.' }, { status: 400 })
  }

  const profile: Record<string, unknown> = {}
  if (about !== undefined) profile.about = about
  if (address !== undefined) profile.address = address
  if (description !== undefined) profile.description = description
  if (email !== undefined) profile.email = email
  if (vertical !== undefined) profile.vertical = vertical
  if (websites !== undefined) profile.websites = (websites as string[]).filter((w) => w.trim().length > 0)

  try {
    await updateWhatsAppBusinessProfile({
      phoneNumberId: config.phone_number_id,
      accessToken,
      profile,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Meta API error'
    return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
  }
}
