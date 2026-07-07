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

// ---------------------------------------------------------------------------
// Live equity stream for the 5 active REAL accounts
// (#32081/#43306 on VPS5 · #25425/#43411/#43414 on VPS6).
// Reads from public.live_real_state via Supabase Realtime + REST.
// Published every ~3s by C:\mt5-mcp\live_publisher.py on each VPS (roster in
// C:\mt5-mcp\.live_publisher.env), held alive by the Railway "kiz-live-bridge"
// worker (see Battle of Bots/railway/live-bridge/).
// ---------------------------------------------------------------------------
(function () {
  if (window.kizLiveReal) return;

  const TABLE = "live_real_state";

  async function fetchOnce() {
    if (!window.kizSupabase) return [];
    const { data, error } = await window.kizSupabase
      .from(TABLE)
      .select("login,vps,ts,balance,equity,margin,free_margin,profit,positions,source_age_ms,publisher_id")
      .order("login", { ascending: true });
    if (error) {
      console.warn("[kiz] live_real_state fetch failed", error.message || error);
      return [];
    }
    return Array.isArray(data) ? data : [];
  }

  function subscribe(onUpdate, onStatus) {
    if (!window.kizSupabase || typeof onUpdate !== "function") return null;
    // Unique topic per attempt so a half-dead prior channel can't collide.
    const channel = window.kizSupabase
      .channel("kiz-live-real-" + Math.random().toString(36).slice(2, 8))
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: TABLE },
        (payload) => {
          const row = payload.new || payload.old;
          if (row) {
            try { onUpdate(row, payload.eventType); }
            catch (err) { console.error("[kiz] live onUpdate handler threw", err); }
          }
        }
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          console.warn("[kiz] live channel status:", status);
        }
        if (typeof onStatus === "function") {
          try { onStatus(status); } catch (err) { console.error("[kiz] live onStatus threw", err); }
        }
      });
    return channel;
  }

  function unsubscribe(channel) {
    if (channel && window.kizSupabase) {
      try { window.kizSupabase.removeChannel(channel); } catch {}
    }
  }

  // Managed transport with automatic failover (Realtime → REST polling → back).
  // The publisher UPSERTs every ~3s, so a Realtime socket silent for >SILENCE_MS
  // is dead (or the publisher is down — polling reveals which: fresh rows via
  // REST = socket problem; stale rows too = publisher down, pill goes red).
  // While the socket is down, REST polling of the SAME table keeps the numbers
  // live, and the socket is retried with exponential backoff.
  const SILENCE_MS = 10000;
  const POLL_MS = 5000;
  const CHECK_MS = 3000;
  const BACKOFF_MS = [5000, 15000, 45000, 120000];

  // Breaker del socket Realtime con memoria entre visitas (localStorage): si
  // el WS falló ≥3 veces seguidas hace <10 min, la próxima carga arranca
  // directo en polling y sonda el socket al vencer el cooldown (half-open),
  // en vez de re-martillear un transporte que ya se sabe caído.
  const WS_BREAKER_KEY = "kiz.breaker.ws";
  const WS_BREAKER_FAILS = 3;
  const WS_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
  function readWsBreaker() {
    try { return JSON.parse(localStorage.getItem(WS_BREAKER_KEY)) || { fails: 0, last: 0 }; }
    catch { return { fails: 0, last: 0 }; }
  }
  function writeWsBreaker(b) {
    try { localStorage.setItem(WS_BREAKER_KEY, JSON.stringify(b)); } catch { /* private mode */ }
  }

  function connect(onUpdate, onMode) {
    const st = {
      mode: null,            // 'realtime' | 'polling'
      channel: null,
      channelToken: null,    // identity guard: ignore status of dropped channels
      pollTimer: null,
      checkTimer: null,
      retryTimer: null,
      backoffIdx: 0,
      lastEventAt: Date.now(),
      stopped: false,
    };

    function setMode(mode) {
      if (st.mode === mode) return;
      st.mode = mode;
      if (typeof onMode === "function") {
        try { onMode(mode); } catch (err) { console.error("[kiz] live onMode threw", err); }
      }
    }

    async function pollNow() {
      const rows = await fetchOnce();
      if (st.stopped) return;
      rows.forEach((r) => {
        try { onUpdate(r, "POLL"); }
        catch (err) { console.error("[kiz] live onUpdate (poll) threw", err); }
      });
    }

    function startPolling() {
      if (st.pollTimer) return;
      setMode("polling");
      pollNow();
      st.pollTimer = setInterval(pollNow, POLL_MS);
    }

    function stopPolling() {
      if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
    }

    function dropChannel() {
      st.channelToken = null;
      if (st.channel) { unsubscribe(st.channel); st.channel = null; }
    }

    function scheduleRetry() {
      if (st.stopped || st.retryTimer) return;
      const delay = BACKOFF_MS[Math.min(st.backoffIdx, BACKOFF_MS.length - 1)];
      st.backoffIdx += 1;
      st.retryTimer = setTimeout(() => { st.retryTimer = null; openChannel(); }, delay);
    }

    function failover() {
      const wb = readWsBreaker();
      writeWsBreaker({ fails: wb.fails + 1, last: Date.now() });
      startPolling();
      dropChannel();
      scheduleRetry();
    }

    function openChannel() {
      if (st.stopped) return;
      dropChannel();
      const token = {};
      st.channelToken = token;
      st.channel = subscribe(
        (row, evt) => {
          st.lastEventAt = Date.now();
          onUpdate(row, evt);
        },
        (status) => {
          if (st.stopped || st.channelToken !== token) return;
          if (status === "SUBSCRIBED") {
            st.lastEventAt = Date.now();
            st.backoffIdx = 0;
            writeWsBreaker({ fails: 0, last: Date.now() });  // transporte probado → closed
            stopPolling();
            setMode("realtime");
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            failover();
          }
        }
      );
      if (!st.channel) failover();
    }

    function checkSilence() {
      if (st.stopped) return;
      // mode === null covers a socket that never reaches SUBSCRIBED and never errors.
      if (st.mode !== "polling" && Date.now() - st.lastEventAt > SILENCE_MS) {
        console.warn("[kiz] live socket silent >" + SILENCE_MS + "ms — falling back to REST polling");
        failover();
      }
    }
    st.checkTimer = setInterval(checkSilence, CHECK_MS);

    const onVisible = () => {
      if (document.visibilityState !== "visible" || st.stopped) return;
      pollNow(); // instant resync on tab return instead of waiting for next tick
      if (st.mode !== "realtime") {
        st.backoffIdx = 0;
        if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
        openChannel();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    // Tuning shadow (aprendizaje continuo): loguea qué recomendaría el
    // adaptive_tuner para el polling — NO se aplica (proceso shadow-first).
    fetch("data/tuning.json")
      .then((r) => (r && r.ok ? r.json() : null))
      .then((t) => {
        const rec = t && t.recommendations && t.recommendations.frontend_poll_ms;
        if (rec && rec.recommended !== rec.current) {
          console.info("[kiz] tuning shadow: POLL_MS recomendado " + rec.recommended +
            " (vigente " + rec.current + ") — " + rec.reason + " [NO aplicado]");
        }
      })
      .catch(() => {});

    // First data without waiting for the socket, then bring up Realtime —
    // salvo que el breaker del WS esté abierto: polling de entrada y sonda
    // del socket cuando venza el cooldown (half-open).
    pollNow();
    const wb = readWsBreaker();
    const wsOpenLeft = wb.fails >= WS_BREAKER_FAILS ? wb.last + WS_BREAKER_COOLDOWN_MS - Date.now() : 0;
    if (wsOpenLeft > 0) {
      console.warn("[kiz] ws breaker open (" + wb.fails + " fails) — polling now, socket probe in " + Math.round(wsOpenLeft / 1000) + "s");
      startPolling();
      st.retryTimer = setTimeout(() => { st.retryTimer = null; openChannel(); }, wsOpenLeft);
    } else {
      openChannel();
    }

    return {
      stop() {
        st.stopped = true;
        stopPolling();
        if (st.checkTimer) { clearInterval(st.checkTimer); st.checkTimer = null; }
        if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
        dropChannel();
        document.removeEventListener("visibilitychange", onVisible);
      },
      get mode() { return st.mode; },
    };
  }

  window.kizLiveReal = { fetchOnce, subscribe, unsubscribe, connect };
})();
