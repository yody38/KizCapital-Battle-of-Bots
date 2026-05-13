// Redirects to /login.html if there is no Supabase session.
// Handles the magic-link callback (URL hash contains access_token) by
// waiting briefly for supabase-js to parse it before deciding.
(async function () {
  function goLogin() {
    const here = window.location.pathname + window.location.search;
    const next = encodeURIComponent(here);
    window.location.replace("/login.html?next=" + next);
  }

  if (!window.kizSupabase) {
    console.error("[kiz] auth-guard: supabase client missing");
    goLogin();
    return;
  }

  async function fetchSession() {
    try {
      const { data } = await window.kizSupabase.auth.getSession();
      return data?.session || null;
    } catch (e) {
      console.error("[kiz] getSession threw", e);
      return null;
    }
  }

  let session = await fetchSession();

  // If URL has a magic-link token (PKCE ?code= or implicit #access_token=),
  // supabase-js may still be processing it. Wait up to 3s for SIGNED_IN.
  const hash = window.location.hash || "";
  const query = window.location.search || "";
  const hasToken =
    /access_token|error_description/.test(hash) ||
    /[?&](code|token_hash|error)=/.test(query);
  if (!session && hasToken) {
    session = await new Promise((resolve) => {
      let resolved = false;
      const finish = (s) => {
        if (resolved) return;
        resolved = true;
        try { sub?.data?.subscription?.unsubscribe?.(); } catch {}
        resolve(s);
      };
      const sub = window.kizSupabase.auth.onAuthStateChange((_event, s) => {
        if (s) finish(s);
      });
      setTimeout(() => finish(null), 3000);
    });
    if (!session) session = await fetchSession();
    // Clean the hash so a refresh doesn't try to reprocess.
    if (session) {
      try {
        history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {}
    }
  }

  if (!session) {
    goLogin();
    return;
  }

  window.kizUserEmail = session.user.email;
  window.dispatchEvent(new Event("kiz-session-ready"));
})();
