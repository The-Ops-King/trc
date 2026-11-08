export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main>
      <form className="card login" method="post" action="/api/login">
        <img src="/logo.png" alt="Tiffany Rose Coaching" />
        <div className="muted small">Funnel Dashboard</div>
        <input type="password" name="password" placeholder="Password" autoFocus required autoComplete="current-password" />
        <button className="primary" type="submit">Sign in</button>
        {error === "1" && <p className="err">Wrong password.</p>}
        {error === "config" && <p className="err">DASHBOARD_PASSWORD is not set for this deployment.</p>}
      </form>
    </main>
  );
}
