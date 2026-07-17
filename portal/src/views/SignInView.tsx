import { SswLogo } from "../components/SswLogo";

type Props = { loginUrl: string };

// SWA normally redirects unauthenticated users straight to Entra (via the 401
// override in staticwebapp.config.json), so this screen is mainly the logout
// landing page and a local-dev fallback rather than a primary login flow.
export function SignInView({ loginUrl }: Props) {
  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-[420px] rounded-ds border border-black/10 bg-white p-10 text-center shadow-ds-raised">
        <SswLogo className="mx-auto h-8 w-auto text-secondary" />
        <h1 className="mt-6 text-2xl font-bold tracking-[-0.02em] text-ssw-charcoal-800">Sign in to Parrot</h1>
        <p className="mx-auto mt-2 max-w-[320px] text-sm text-ssw-gray-500">
          Use your SSW account to upload transcripts and view the dashboards you have generated.
        </p>
        <a
          href={loginUrl}
          className="mt-6 inline-flex w-full items-center justify-center rounded-ds-sm border border-primary bg-primary px-5 py-3.5 font-semibold text-white transition hover:bg-ssw-red-600"
        >
          Sign in with SSW
        </a>
      </div>
    </main>
  );
}
