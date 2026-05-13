// Kiz Capital — Login flow (Supabase magic-link sign-in).
// User enters email → Supabase emails a magic link → user clicks link →
// returns here with #access_token in URL → supabase-js detects → session.
(function () {
  const $email   = document.getElementById("email-input");
  const $stepE   = document.getElementById("step-email");
  const $stepC   = document.getElementById("step-code");
  const $subm    = document.getElementById("email-submit");
  const $errE    = document.getElementById("email-error");
  const $errC    = document.getElementById("code-error");
  const $target  = document.getElementById("code-target");
  const $title   = document.getElementById("login-title");
  const $sub     = document.getElementById("login-sub");
  const $resend  = document.getElementById("resend-btn");
  const $change  = document.getElementById("change-email-btn");

  let currentEmail = "";
  let resendCooldownTimer = null;

  function nextUrl() {
    const params = new URLSearchParams(window.location.search);
    const next = params.get("next");
    if (!next) return "/index.html";
    try {
      const u = new URL(next, window.location.origin);
      if (u.origin !== window.location.origin) return "/index.html";
      return u.pathname + u.search + u.hash;
    } catch {
      return "/index.html";
    }
  }

  function setError(el, msg) {
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  function setLoading(btn, on) {
    btn.classList.toggle("loading", on);
    btn.disabled = !!on;
  }

  function showSentStep() {
    $stepE.hidden = true;
    $stepC.hidden = false;
    $title.textContent = "Revisa tu correo";
    $sub.textContent = "Te enviamos un enlace para entrar.";
    $target.textContent = currentEmail;
  }

  function showEmailStep() {
    $stepC.hidden = true;
    $stepE.hidden = false;
    $title.textContent = "Acceso al portfolio";
    $sub.textContent = "Ingresa tu correo para recibir un enlace de acceso.";
    setError($errE, null);
    setError($errC, null);
    setTimeout(() => $email.focus(), 60);
  }

  function startResendCooldown(seconds) {
    clearInterval(resendCooldownTimer);
    let s = seconds;
    $resend.disabled = true;
    const tick = () => {
      $resend.textContent = s > 0 ? `Reenviar (${s}s)` : "Reenviar enlace";
      if (s <= 0) { clearInterval(resendCooldownTimer); $resend.disabled = false; return; }
      s -= 1;
    };
    tick();
    resendCooldownTimer = setInterval(tick, 1000);
  }

  function friendlyAuthError(error) {
    if (!error) return "";
    const msg = (error.message || "").toLowerCase();
    if (msg.includes("email_not_whitelisted") || msg.includes("not authorized") || msg.includes("signups not allowed")) {
      return "Este correo no tiene acceso. Pídele al administrador que te agregue a la whitelist.";
    }
    if (msg.includes("rate limit") || msg.includes("too many")) {
      return "Demasiados intentos. Espera unos minutos antes de reintentar.";
    }
    return error.message || "Ocurrió un error. Inténtalo de nuevo.";
  }

  async function sendMagicLink(email) {
    return window.kizSupabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: window.location.origin + "/",
      },
    });
  }

  // -------- Step 1: send email --------
  $stepE.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setError($errE, null);
    const email = $email.value.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setError($errE, "Ingresa un correo válido.");
      return;
    }
    setLoading($subm, true);
    try {
      const { error } = await sendMagicLink(email);
      if (error) { setError($errE, friendlyAuthError(error)); return; }
      currentEmail = email;
      showSentStep();
      startResendCooldown(60);
    } catch (err) {
      console.error("[kiz] sendMagicLink threw", err);
      setError($errE, "No se pudo enviar el enlace. Intenta de nuevo.");
    } finally {
      setLoading($subm, false);
    }
  });

  // -------- Resend / change email --------
  $resend.addEventListener("click", async () => {
    if ($resend.disabled) return;
    setError($errC, null);
    startResendCooldown(60);
    try {
      const { error } = await sendMagicLink(currentEmail);
      if (error) setError($errC, friendlyAuthError(error));
    } catch (err) {
      console.error("[kiz] resend threw", err);
      setError($errC, "No se pudo reenviar. Intenta de nuevo.");
    }
  });

  $change.addEventListener("click", () => {
    clearInterval(resendCooldownTimer);
    currentEmail = "";
    showEmailStep();
  });

  // -------- Auto-redirect if session ready (covers magic-link callback) --------
  (async () => {
    if (!window.kizSupabase) return;

    // Initial check
    let { data } = await window.kizSupabase.auth.getSession();
    if (data?.session) { window.location.replace(nextUrl()); return; }

    // If URL has a magic-link token, supabase-js is parsing it. Wait up to 5s.
    const hash = window.location.hash || "";
    if (/access_token|error_description/.test(hash)) {
      const session = await new Promise((resolve) => {
        let done = false;
        const finish = (s) => {
          if (done) return;
          done = true;
          try { sub?.data?.subscription?.unsubscribe?.(); } catch {}
          resolve(s);
        };
        const sub = window.kizSupabase.auth.onAuthStateChange((_e, s) => {
          if (s) finish(s);
        });
        setTimeout(() => finish(null), 5000);
      });
      if (session) {
        try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch {}
        window.location.replace(nextUrl());
      }
    }
  })();
})();
