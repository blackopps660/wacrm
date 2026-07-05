-- Meta's status-update webhook includes an `errors` array whenever
-- status = 'failed' (code/title/message/details), but the webhook
-- handler previously discarded it and only wrote the bare status.
-- That left failed sends with no way to tell why from wacrm's own
-- data — diagnosing a real failure required cross-referencing Meta's
-- dashboard by hand. This column captures a human-readable version
-- of Meta's first error so it can be surfaced in the inbox.
alter table messages
  add column if not exists error_message text;
