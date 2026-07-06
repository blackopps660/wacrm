// Public, unauthenticated privacy policy — required by Meta's App
// Review for WhatsApp Business Platform access (the "Privacy Policy
// URL" field under App Settings). No layout wrapper needed since this
// must render for anonymous visitors.

export const metadata = {
  title: 'Privacy Policy — BlinkMoon',
  robots: { index: true, follow: true },
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-16 text-slate-200">
      <div className="mx-auto max-w-2xl space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">Privacy Policy</h1>
          <p className="mt-2 text-sm text-slate-400">Last updated: July 2026</p>
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">1. Overview</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            BlinkMoon (&quot;we&quot;, &quot;us&quot;) provides a WhatsApp Business CRM that lets
            businesses manage conversations, contacts, and sales pipelines through the WhatsApp
            Business Platform (operated by Meta). This policy explains what data we collect, how
            we use it, and how it&apos;s protected.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">2. Information We Collect</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-300">
            <li>
              <strong className="text-slate-100">Account information</strong>: name, email address,
              and password (encrypted) when you sign up.
            </li>
            <li>
              <strong className="text-slate-100">WhatsApp Business API credentials</strong>: your
              WhatsApp Business Account ID, phone number ID, and access token, used solely to send
              and receive messages on your behalf via Meta&apos;s WhatsApp Business Platform.
              Access tokens are encrypted at rest.
            </li>
            <li>
              <strong className="text-slate-100">Message content and metadata</strong>: WhatsApp
              conversations, contact names/phone numbers, and message timestamps, stored so you
              can view and manage your own conversation history.
            </li>
            <li>
              <strong className="text-slate-100">CRM data</strong>: contacts, deals, tags, notes,
              and pipeline data you create while using the product.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">3. How We Use Information</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            We use this data exclusively to operate the product: routing your WhatsApp messages,
            displaying your conversation history, powering dashboard analytics, and sending you
            account-related notifications (including push notifications for new messages). We do
            not sell your data or use it for advertising.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">4. Data Sharing</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            Message data is shared with Meta as required to operate the WhatsApp Business
            Platform integration (this is inherent to how WhatsApp Business messaging works).
            We do not share your data with any other third party except infrastructure providers
            (hosting, database) strictly necessary to run the service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">5. Data Retention &amp; Deletion</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            We retain your data for as long as your account is active. You can request deletion
            of your account and associated data at any time by contacting us below.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">6. Security</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            WhatsApp access tokens are encrypted at rest. Access to your data is restricted to
            your own account via row-level security, and all traffic is encrypted in transit
            (HTTPS/TLS).
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-slate-100">7. Contact</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            Questions about this policy or a data deletion request? Contact us at{' '}
            <a href="mailto:support@blinkmoon.io" className="text-violet-400 underline">
              support@blinkmoon.io
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
