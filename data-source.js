// Transparent fetch interceptor: rewrites `data/...` paths to Supabase
// Storage signed URLs after the user is authenticated.
// Load AFTER auth-guard.js, BEFORE app.js. Existing app.js is untouched.
(function () {
  if (window.__kizFetchPatched) return;
  window.__kizFetchPatched = true;

  const originalFetch = window.fetch.bind(window);
  const signedUrlCache = new Map(); // path -> { url, exp }
  const URL_TTL_MS = 9 * 60 * 1000;  // signed URL is good for 10 min; refresh at 9

  // Wait for session before issuing any data/* fetch.
  const sessionReady =
    window.kizUserEmail
      ? Promise.resolve()
      : new Promise((resolve) => {
          window.addEventListener("kiz-session-ready", () => resolve(), { once: true });
        });

  function pathFromDataUrl(rawUrl) {
    let s = String(rawUrl);
    const qi = s.indexOf("?");
    if (qi >= 0) s = s.slice(0, qi);
    const hi = s.indexOf("#");
    if (hi >= 0) s = s.slice(0, hi);
    if (s.startsWith("./")) s = s.slice(2);
    return s.startsWith("data/") ? s.slice(5) : null;
  }

  async function getSignedUrl(path) {
    const cached = signedUrlCache.get(path);
    if (cached && cached.exp > Date.now()) return cached.url;
    if (!window.kizStorage) return null;
    const url = await window.kizStorage.signedUrl(path, 600);
    if (url) signedUrlCache.set(path, { url, exp: Date.now() + URL_TTL_MS });
    return url;
  }

  async function patchedFetch(input, init) {
    const rawUrl =
      typeof input === "string"
        ? input
        : input && typeof input.url === "string"
        ? input.url
        : "";

    // Only rewrite relative paths starting with data/
    if (!rawUrl || /^https?:\/\//.test(rawUrl) || rawUrl.startsWith("/")) {
      return originalFetch(input, init);
    }

    const path = pathFromDataUrl(rawUrl);
    if (!path) return originalFetch(input, init);

    await sessionReady;
    const signed = await getSignedUrl(path);
    if (!signed) {
      return new Response(JSON.stringify({ error: "storage signed url failed", path }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Drop the original Request object — we use a fresh URL
    return originalFetch(signed, init);
  }

  window.fetch = patchedFetch;
})();

// Live equity stream for real accounts removed 2026-05-17 to fit GH Actions
// free tier. Real accounts now use the same 30-min snapshot path as demos.
