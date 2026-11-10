/**
 * Supabase's session-mode pooler (port 5432 on *.pooler.supabase.com) gives each client connection one of a small, shared set
 * of server connections and holds it for as long as the client stays connected. The page opens several connections at once
 * (its queries run in parallel), and when the set is taken the new ones wait in the pooler's queue with no error: the page hung
 * (2026-11-10). The transaction-mode pooler (port 6543) lends a server connection per transaction instead. Same rewrite the
 * Backend-in-a-box engine makes for the same reason.
 */
export function transactionPoolerUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".pooler.supabase.com") && (u.port === "5432" || u.port === "")) u.port = "6543";
    return u.toString();
  } catch {
    return url;
  }
}
