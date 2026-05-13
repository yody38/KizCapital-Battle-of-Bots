// Kiz Capital — Supabase client singleton.
// Reads SUPABASE_URL and SUPABASE_ANON_KEY from window.__KIZ_CONFIG__,
// which is injected by /config.js at runtime (served by Vercel from env vars).

(function () {
  if (window.kizSupabase) return;

  const cfg = window.__KIZ_CONFIG__ || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    console.error(
      "[kiz] Supabase config missing. Make sure /config.js is loaded before this script.",
    );
    return;
  }

  if (!window.supabase || !window.supabase.createClient) {
    console.error(
      "[kiz] supabase-js not loaded. Include the UMD bundle before supabase-client.js.",
    );
    return;
  }

  window.kizSupabase = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "implicit",
        storageKey: "kiz-capital-auth",
      },
    },
  );
})();

// ---------- Public helpers ----------

window.kizAuth = {
  async getSession() {
    const { data, error } = await window.kizSupabase.auth.getSession();
    if (error) {
      console.error("[kiz] getSession error", error);
      return null;
    }
    return data.session;
  },

  async getUserEmail() {
    const session = await this.getSession();
    return session?.user?.email || null;
  },

  async signOut() {
    await window.kizSupabase.auth.signOut();
  },

  async requestOtp(email) {
    return window.kizSupabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: undefined,
      },
    });
  },

  async verifyOtp(email, token) {
    return window.kizSupabase.auth.verifyOtp({
      email,
      token,
      type: "email",
    });
  },
};

// ---------- Storage helper for dashboard JSONs ----------

window.kizStorage = {
  async signedUrl(path, expiresIn = 600) {
    const { data, error } = await window.kizSupabase.storage
      .from("dashboard-data")
      .createSignedUrl(path, expiresIn);
    if (error) {
      console.error("[kiz] signedUrl error", path, error);
      return null;
    }
    return data.signedUrl;
  },

  async fetchJson(path) {
    const url = await this.signedUrl(path);
    if (!url) return null;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.error("[kiz] fetchJson failed", path, res.status);
      return null;
    }
    return res.json();
  },
};
