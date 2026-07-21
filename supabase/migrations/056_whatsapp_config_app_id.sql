-- whatsapp_config: optional per-account Meta App ID
--
-- Why this exists:
--   Meta's Resumable Upload API (used for WhatsApp profile photos and
--   image-header templates) is app-scoped: POST /{app_id}/uploads must
--   be called with an access token that belongs to that exact app_id,
--   or Meta rejects it with "Object with ID '<app_id>' does not exist,
--   cannot be loaded due to missing permissions." wacrm previously used
--   a single hardcoded META_APP_ID env var for every account, which
--   only works when every connected number's token was issued by that
--   one app. A second account connected via a different Meta App
--   (manual-token flow, e.g. a client's own app) hits that exact error
--   the moment it tries to upload a profile photo or template header
--   image — its token doesn't match the app_id being called.
--
--   This column lets an account override the App ID used for those
--   upload calls. NULL falls back to the server-wide META_APP_ID env
--   var, so existing single-app deployments need no changes.
--
-- Idempotent — safe to re-run.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS app_id TEXT;
