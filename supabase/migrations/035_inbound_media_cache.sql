-- ============================================================
-- 035_inbound_media_cache.sql — private bucket for cached/compressed
-- inbound WhatsApp media
--
-- Today, inbound image/video/audio/document media is never stored by
-- us — `messages.media_url` for an inbound row is a path to our own
-- on-demand proxy (`/api/whatsapp/media/{mediaId}`), which re-fetches
-- the bytes from Meta on every single view. That's both slow (a Meta
-- round trip per view) and wasteful (the same photo re-downloaded
-- every time an agent opens the thread).
--
-- This bucket lets the webhook download an inbound image/video ONCE,
-- compress it, and cache the result here; the proxy route then serves
-- from this bucket when a cached copy exists, falling back to the old
-- live-Meta-fetch behaviour (and opportunistically populating the
-- cache) for anything that predates this migration.
--
-- Deliberately PRIVATE (unlike chat-media, which must be public so
-- Meta can fetch outbound sends) — inbound media is customer content
-- and today is only ever visible to a logged-in team member via the
-- authenticated proxy route. Storing it publicly would be a real
-- privacy regression, so reads are scoped to account membership via
-- RLS, mirroring the path convention every other account-scoped
-- bucket in this app uses (`account-<account_id>/...`).
--
-- Only the webhook (service role) ever writes here — service role
-- bypasses RLS, so no INSERT/UPDATE/DELETE policy is needed for
-- `authenticated`; nothing in the client app should ever write
-- directly to this bucket.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'inbound-media',
  'inbound-media',
  FALSE,
  16777216, -- 16 MB, matching Meta's own inbound size ceiling
  ARRAY[
    'image/png', 'image/jpeg', 'image/webp',
    'video/mp4', 'video/3gpp'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Reads only — account members reading their own inbound media via
-- the proxy route. No public policy (private bucket).
DROP POLICY IF EXISTS "Members can read their inbound media" ON storage.objects;
CREATE POLICY "Members can read their inbound media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'inbound-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
