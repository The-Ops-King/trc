// The dashboard's tabs: the webinar funnel and the sales tracker (Tyler, 2026-11-20: "a separate tab").
export function Tabs({ active }: { active: "webinar" | "sales" }) {
  return (
    <nav className="seg tabs" aria-label="Dashboard">
      <a href="/" className={active === "webinar" ? "active" : ""}>Webinar</a>
      <a href="/sales" className={active === "sales" ? "active" : ""}>Sales tracker</a>
    </nav>
  );
}
