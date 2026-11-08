export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main>
      <form className="card login" method="post" action="/api/login">
        <h1>TRC Dashboard</h1>
        <input type="password" name="password" placeholder="Password" autoFocus required autoComplete="current-password" />
        <button className="primary" type="submit">Sign in</button>
        {error === "1" && <p className="small" style={{ color: "var(--bad)" }}>Wrong password.</p>}
        {error === "config" && <p className="small" style={{ color: "var(--bad)" }}>DASHBOARD_PASSWORD is not set for this deployment.</p>}
      </form>
    </main>
  );
}
