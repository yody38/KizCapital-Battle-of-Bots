// Redirects to /login.html if there is no Supabase session.
// Load this BEFORE app.js in every protected page (index.html).
(async function () {
  function go(url) {
    const here = window.location.pathname + window.location.search;
    const next = encodeURIComponent(here);
    window.location.replace(url + "?next=" + next);
  }

  if (!window.kizSupabase) {
    console.error("[kiz] auth-guard: supabase client missing");
    go("/login.html");
    return;
  }

  const session = await window.kizAuth.getSession();
  if (!session) {
    go("/login.html");
    return;
  }

  // Expose for app.js
  window.kizUserEmail = session.user.email;
  window.dispatchEvent(new Event("kiz-session-ready"));
})();
