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

  // [VELOCIDAD F6] Firma N objetos en UNA sola petición (POST /object/sign con
  // {paths:[...]}) en vez de una por archivo. El boot pide ~10 JSONs y cada
  // firma costaba su propio round-trip a origen (175-524 ms medidos), así que
  // eran ~10 RTT de puro protocolo antes del primer byte de datos.
  // Devuelve [{path, signedUrl}] solo con los que la API firmó bien: un path
  // ausente en Storage no invalida el lote, simplemente no viene en la lista y
  // el llamador cae al camino de firma individual.
  async signedUrls(paths, expiresIn = 600) {
    if (!Array.isArray(paths) || !paths.length) return [];
    const { data, error } = await window.kizSupabase.storage
      .from("dashboard-data")
      .createSignedUrls(paths, expiresIn);
    if (error) {
      console.error("[kiz] signedUrls error", error);
      return [];
    }
    return (data || [])
      .filter((r) => r && r.path && r.signedUrl && !r.error)
      .map((r) => ({ path: r.path, url: r.signedUrl }));
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
