-- ============================================================
-- 051_raise_document_limit.sql
--
-- Raises the chat-media bucket's file_size_limit from 16 MB to
-- 30 MB. This ONLY unblocks documents — Meta's WhatsApp Cloud API
-- hard-caps images at 5 MB and video/audio at 16 MB server-side
-- regardless of what we allow into storage, so those three kinds
-- stay exactly where they were in MEDIA_MAX_BYTES_BY_KIND (web:
-- src/lib/storage/upload-media.ts, mobile: mobile/lib/media.ts) —
-- a bigger bucket ceiling doesn't help them, it would just let a
-- too-big image/video upload succeed here and then fail confusingly
-- at Meta's send step instead. Documents can go up to 100 MB on
-- Meta; 30 MB is a deliberately conservative bump, not the max.
--
-- Idempotent — safe to re-run.
-- ============================================================

UPDATE storage.buckets
SET file_size_limit = 31457280 -- 30 MB
WHERE id = 'chat-media';
