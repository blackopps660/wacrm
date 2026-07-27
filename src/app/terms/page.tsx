export const metadata = {
  title: 'Terms of Service — BlinkMoon',
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-16 text-slate-200">
      <div className="mx-auto max-w-2xl space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">Terms of Service</h1>
          <p className="mt-2 text-sm text-slate-400">Last updated: July 2026</p>
        </div>

        <section>
          <p className="text-sm leading-relaxed text-slate-300">
            BlinkMoon provides a WhatsApp Business CRM platform that enables businesses to manage customer conversations using Meta's WhatsApp Business Platform.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-100">Acceptable Use</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            Users agree to use BlinkMoon only for lawful business purposes and in compliance with Meta's Platform Terms and WhatsApp Business Policies.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-100">Accounts</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            You are responsible for maintaining the security of your account and credentials.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-100">Limitation of Liability</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            BlinkMoon is provided as-is. We are not liable for indirect or consequential damages resulting from use of the platform.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-slate-100">Contact</h2>
          <p className="text-sm leading-relaxed text-slate-300">
            support@blinkmoon.io
          </p>
        </section>
      </div>
    </div>
  );
}
