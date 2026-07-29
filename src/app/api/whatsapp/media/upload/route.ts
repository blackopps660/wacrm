import { NextResponse } from 'next/server'
import { createClientForRequest } from '@/lib/supabase/server'
import { compressImage, compressVideo } from '@/lib/storage/compress-media'
import { buildMediaPath, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST /api/whatsapp/media/upload
//
// Compressing counterpart to the composer's direct browser->Storage
// upload (`uploadAccountMedia`). Images and videos an agent attaches
// route through here instead so they get the same compression pass
// inbound media gets — sharp for images, ffmpeg for video (see
// src/lib/storage/compress-media.ts). Both native libraries only run
// server-side, so this is a real HTTP round trip rather than a
// client-side transform.
//
// Documents and voice notes are NOT accepted here — documents aren't
// compressed at all, and voice notes are already Opus-encoded client-
// side by opus-recorder (re-compressing a lossy Opus stream server-
// side would only spend CPU to make it worse). Both keep using
// `uploadAccountMedia`'s direct upload straight from the composer.
//
// Auth accepts either the dashboard's cookie session or a mobile
// client's Bearer token (createClientForRequest), account resolved via
// `profiles`, Storage write scoped to the account's folder by the same
// RLS policy `uploadAccountMedia` relies on (migration 023) — this
// route just does the compress step in between, using the same
// account-scoped path convention so both upload paths are
// indistinguishable to everything downstream.
// ============================================================

export const CHAT_MEDIA_BUCKET = 'chat-media'

const COMPRESSIBLE_KINDS = ['image', 'video'] as const
type CompressibleKind = (typeof COMPRESSIBLE_KINDS)[number]

function isCompressibleKind(value: unknown): value is CompressibleKind {
  return typeof value === 'string' && (COMPRESSIBLE_KINDS as readonly string[]).includes(value)
}

// Mirrors the chat-media bucket's `allowed_mime_types` (migration 023)
// for the two kinds this route handles — checked BEFORE the Storage
// call so an unsupported format (most commonly iPhone HEIC photos,
// which sharp's prebuilt binary can't decode — confirmed via
// `sharp.format.heif`, which only lists `.avif`) gets a clear,
// actionable message instead of Storage's generic rejection surfacing
// as an opaque "Upload failed" with no indication of why.
const SUPPORTED_MIME_BY_KIND: Record<CompressibleKind, string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp'],
  video: ['video/mp4', 'video/3gpp'],
}

const UNSUPPORTED_FORMAT_HINT: Record<CompressibleKind, string> = {
  image:
    "This image format isn't supported (likely HEIC from an iPhone). On iPhone, go to Settings > Camera > Formats > Most Compatible, or share it as a screenshot instead.",
  video:
    "This video format isn't supported. Please try a different video, or re-export it as MP4.",
}

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

    const limit = checkRateLimit(`media-upload:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

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

    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    const kind = form?.get('kind')

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "'file' is required" }, { status: 400 })
    }
    if (!isCompressibleKind(kind)) {
      return NextResponse.json(
        { error: "'kind' must be 'image' or 'video'" },
        { status: 400 },
      )
    }

    const maxBytes = MEDIA_MAX_BYTES_BY_KIND[kind]
    if (file.size > maxBytes) {
      return NextResponse.json(
        {
          error: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB — ${kind} limit is ${Math.round(
            maxBytes / 1024 / 1024,
          )} MB.`,
        },
        { status: 400 },
      )
    }

    const inputBuffer = Buffer.from(await file.arrayBuffer())
    const mimeType = file.type || (kind === 'image' ? 'image/jpeg' : 'video/mp4')

    const compressed =
      kind === 'image'
        ? await compressImage(inputBuffer, mimeType)
        : await compressVideo(inputBuffer, mimeType)

    if (!SUPPORTED_MIME_BY_KIND[kind].includes(compressed.mimeType)) {
      return NextResponse.json({ error: UNSUPPORTED_FORMAT_HINT[kind] }, { status: 400 })
    }

    const path = buildMediaPath(accountId, file.name)
    const { error: uploadErr } = await supabase.storage
      .from(CHAT_MEDIA_BUCKET)
      .upload(path, compressed.buffer, {
        cacheControl: '3600',
        upsert: false,
        contentType: compressed.mimeType,
      })
    if (uploadErr) {
      console.error('[media/upload] storage upload failed:', uploadErr.message)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path)

    return NextResponse.json({ publicUrl, path })
  } catch (err) {
    console.error('[media/upload] unexpected error:', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
