import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { compressImage, compressVideo } from '@/lib/storage/compress-media'

// Matches the extensions `cacheInboundMedia` (webhook/route.ts) and the
// self-heal path below actually write — derived from the mime subtype
// after compression, not a fixed list, so this must stay in sync with
// every mime type compress-media.ts can hand back.
const CACHE_EXTENSIONS = ['jpeg', 'png', 'webp', 'mp4', '3gpp']

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
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

    // Cache check first (migration 035 / the webhook's cacheInboundMedia)
    // — the webhook already downloaded, compressed, and stored this file
    // under `account-<accountId>/inbound/<mediaId>.<ext>` for most
    // image/video messages, so the common case never touches Meta at
    // all. RLS on storage.objects scopes this read to the caller's own
    // account regardless of which extension we happen to guess right.
    for (const ext of CACHE_EXTENSIONS) {
      const path = `account-${accountId}/inbound/${mediaId}.${ext}`
      const { data: cached, error: cacheErr } = await supabase.storage
        .from('inbound-media')
        .download(path)
      if (!cacheErr && cached) {
        return new Response(cached, {
          status: 200,
          headers: {
            'Content-Type': cached.type || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000',
          },
        })
      }
    }

    // Cache miss — either this file predates migration 035, isn't an
    // image/video (audio/documents are never cached), or the webhook's
    // best-effort caching failed. Fall back to the original live-Meta
    // fetch so the media still loads.
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })
    const effectiveMime = mediaInfo.mimeType || contentType || 'application/octet-stream'

    // Self-heal the cache for next time — same compress-then-store logic
    // the webhook uses, so a message that missed caching at ingest time
    // (or one sent before this migration existed) only ever hits Meta
    // once more. Scheduled via `after()` (not a bare detached promise) so
    // the runtime keeps the function alive until it finishes even though
    // the response below has already been sent — same reasoning as the
    // webhook's own `after()` usage (issue #301).
    if (effectiveMime.startsWith('image/') || effectiveMime.startsWith('video/')) {
      after(async () => {
        try {
          const compressed = effectiveMime.startsWith('image/')
            ? await compressImage(buffer, effectiveMime)
            : await compressVideo(buffer, effectiveMime)
          const ext = compressed.mimeType.split('/')[1]?.split(';')[0] || 'bin'
          await supabase.storage
            .from('inbound-media')
            .upload(`account-${accountId}/inbound/${mediaId}.${ext}`, compressed.buffer, {
              contentType: compressed.mimeType,
              upsert: true,
              cacheControl: '31536000',
            })
        } catch (err) {
          console.warn('[media proxy] opportunistic cache-populate failed:', mediaId, err)
        }
      })
    }

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': effectiveMime,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
