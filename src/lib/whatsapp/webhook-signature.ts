import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   `META_APP_SECRET` is **required**. If it's missing we fail closed —
 *   every request is rejected until the operator configures the
 *   secret. A previous version fell open with a warning log, which is
 *   unsafe for a public template: anyone who forgets the env var would
 *   be running a fully spoofable webhook.
 *
 *   `META_APP_SECRET` may hold multiple comma-separated secrets. This
 *   deployment can receive webhook traffic from more than one Meta App
 *   (e.g. a Tech Provider's own app plus a manually-connected client's
 *   app, each with its own App Secret) — Meta signs each request with
 *   the secret of whichever app owns the sending WABA's subscription,
 *   so a single fixed secret silently 401s every event from the other
 *   app(s). Checking against each configured secret in turn keeps the
 *   fail-closed guarantee while supporting that multi-app case.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secretsEnv = process.env.META_APP_SECRET
  if (!secretsEnv) {
    console.error(
      '[webhook] META_APP_SECRET is not set — rejecting request. ' +
        'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
        'to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const a = Buffer.from(signatureHeader)

  const secrets = secretsEnv.split(',').map((s) => s.trim()).filter(Boolean)
  for (const secret of secrets) {
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    const b = Buffer.from(expected)
    // Bail if lengths differ — timingSafeEqual throws otherwise.
    if (a.length !== b.length) continue
    if (crypto.timingSafeEqual(a, b)) return true
  }
  return false
}
