export const metadata = {
  title: 'Data Deletion Instructions — BlinkMoon',
};

export default function DataDeletionPage() {
  return (
    <div className="min-h-screen bg-slate-950 px-4 py-16 text-slate-200">
      <div className="mx-auto max-w-2xl space-y-8">
        <h1 className="text-2xl font-bold text-slate-50">
          Data Deletion Instructions
        </h1>

        <p className="text-sm leading-relaxed text-slate-300">
          If you would like BlinkMoon to delete your account and associated data,
          please email us at:
        </p>

        <p className="text-lg font-semibold text-violet-400">
          support@blinkmoon.io
        </p>

        <p className="text-sm leading-relaxed text-slate-300">
          Include your registered email address and WhatsApp Business Account ID.
          We will verify your request and permanently delete your account and
          associated data within a reasonable period unless we are legally required
          to retain certain information.
        </p>
      </div>
    </div>
  );
}
