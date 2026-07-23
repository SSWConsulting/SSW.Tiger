import { type ClientPrincipal, principalEmail, principalInitials, principalName } from "../api/authClient";
import tigerLogo from "../assets/SSWTiger.svg";

export type View = "upload" | "dashboards";

type Props = {
  view: View;
  onNavigate: (view: View) => void;
  principal: ClientPrincipal;
  logoutUrl: string;
};

const TABS: { id: View; label: string }[] = [
  { id: "upload", label: "Submit a meeting" },
  { id: "dashboards", label: "My submissions" },
];

export function AppHeader({ view, onNavigate, principal, logoutUrl }: Props) {
  const name = principalName(principal);
  const email = principalEmail(principal);
  // Avoid a redundant second line when the display name is just the email
  // (no `name` claim was present).
  const showEmail = email && email !== name;
  return (
    <header className="sticky top-0 z-10 border-b border-black/10 bg-white/90 backdrop-blur">
      <div className="mx-auto flex w-[min(1120px,calc(100%-40px))] items-center gap-6 py-3.5">
        <div className="flex items-center">
          <img src={tigerLogo} alt="SSW Tiger" className="h-14 w-auto" />
        </div>

        <nav className="flex items-center gap-1" aria-label="Primary">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={view === tab.id ? "page" : undefined}
              onClick={() => onNavigate(tab.id)}
              className={`rounded-ds-sm px-3 py-1.5 text-sm font-medium transition ${
                view === tab.id ? "bg-ssw-gray-100 text-ssw-charcoal" : "text-ssw-gray-500 hover:text-ssw-charcoal"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-[13px] font-semibold leading-tight text-ssw-charcoal">{name}</p>
            {showEmail && <p className="text-xs leading-tight text-ssw-gray-500">{email}</p>}
          </div>
          <div
            className="grid h-9 w-9 place-items-center rounded-full bg-secondary text-xs font-bold text-white"
            aria-hidden="true"
          >
            {principalInitials(principal)}
          </div>
          <a
            href={logoutUrl}
            className="rounded-ds-sm border border-black/10 px-3 py-1.5 text-sm font-medium text-ssw-charcoal transition hover:bg-black/5"
          >
            Sign out
          </a>
        </div>
      </div>
    </header>
  );
}
