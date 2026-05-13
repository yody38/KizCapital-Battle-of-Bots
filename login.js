// Kiz Capital — Login flow (Supabase Email OTP, 6 digits).
// Primary: paste the 6-digit code from email. Fallback: click "Sign in"
// link in the email (PKCE or implicit, handled by detectSessionInUrl).
(function () {
  const $email   = document.getElementById("email-input");
  const $stepE   = document.getElementById("step-email");
  const $stepC   = document.getElementById("step-code");
  const $subm    = document.getElementById("email-submit");
  const $codeS   = document.getElementById("code-submit");
  const $errE    = document.getElementById("email-error");
  const $errC    = document.getElementById("code-error");
  const $target  = document.getElementById("code-target");
  const $title   = document.getElementById("login-title");
  const $sub     = document.getElementById("login-sub");
  const $resend  = document.getElementById("resend-btn");
  const $change  = document.getElementById("change-email-btn");
  const cells    = Array.from(document.querySelectorAll(".otp-cell"));

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

  function showCodeStep() {
    $stepE.hidden = true;
    $stepC.hidden = false;
    $title.textContent = "Revisa tu correo";
    $sub.textContent = "Pega el código que recibiste para entrar.";
    $target.textContent = currentEmail;
    setTimeout(() => cells[0]?.focus(), 80);
  }

  function showEmailStep() {
    $stepC.hidden = true;
    $stepE.hidden = false;
    $title.textContent = "Acceso al portfolio";
    $sub.textContent = "Ingresa tu correo para recibir un código de un solo uso.";
    setError($errC, null);
    clearOtp();
    setTimeout(() => $email.focus(), 60);
  }

  function clearOtp() {
    cells.forEach((c) => { c.value = ""; c.classList.remove("filled", "error"); });
  }

  function readOtp() {
    return cells.map((c) => c.value).join("");
  }

  function startResendCooldown(seconds) {
    clearInterval(resendCooldownTimer);
    let s = seconds;
    $resend.disabled = true;
    const tick = () => {
      $resend.textContent = s > 0 ? `Reenviar (${s}s)` : "Reenviar código";
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
    if (msg.includes("token has expired") || msg.includes("invalid otp") || msg.includes("expired") || msg.includes("otp_expired")) {
      return "Código inválido o expirado. Pide uno nuevo.";
    }
    return error.message || "Ocurrió un error. Inténtalo de nuevo.";
  }

  async function sendOtp(email) {
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
      const { error } = await sendOtp(email);
      if (error) { setError($errE, friendlyAuthError(error)); return; }
      currentEmail = email;
      showCodeStep();
      startResendCooldown(60);
    } catch (err) {
      console.error("[kiz] sendOtp threw", err);
      setError($errE, "No se pudo enviar el código. Intenta de nuevo.");
    } finally {
      setLoading($subm, false);
    }
  });

  // -------- Step 2: OTP cells UX --------
  cells.forEach((cell, i) => {
    cell.addEventListener("input", (e) => {
      const v = e.target.value.replace(/\D/g, "");
      e.target.value = v.slice(-1);
      e.target.classList.toggle("filled", !!e.target.value);
      e.target.classList.remove("error");
      if (e.target.value && i < cells.length - 1) cells[i + 1].focus();
      if (readOtp().length === 6) $stepC.requestSubmit();
    });
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !e.target.value && i > 0) {
        cells[i - 1].focus();
        cells[i - 1].value = "";
        cells[i - 1].classList.remove("filled");
        e.preventDefault();
      }
      if (e.key === "ArrowLeft" && i > 0) cells[i - 1].focus();
      if (e.key === "ArrowRight" && i < cells.length - 1) cells[i + 1].focus();
    });
    cell.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text") || "";
      const digits = text.replace(/\D/g, "").slice(0, 6);
      if (!digits) return;
      e.preventDefault();
      cells.forEach((c, idx) => {
        c.value = digits[idx] || "";
        c.classList.toggle("filled", !!c.value);
      });
      const lastIdx = Math.min(digits.length, 6) - 1;
      cells[lastIdx]?.focus();
      if (digits.length === 6) $stepC.requestSubmit();
    });
  });

  // -------- Step 2: verify --------
  $stepC.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setError($errC, null);
    const code = readOtp();
    if (code.length !== 6) {
      setError($errC, "Ingresa los 6 dígitos.");
      return;
    }
    setLoading($codeS, true);
    try {
      const { data, error } = await window.kizSupabase.auth.verifyOtp({
        email: currentEmail,
        token: code,
        type: "email",
      });
      if (error || !data?.session) {
        cells.forEach((c) => c.classList.add("error"));
        setError($errC, friendlyAuthError(error || { message: "Código inválido." }));
        return;
      }
      window.location.replace(nextUrl());
    } catch (err) {
      console.error("[kiz] verifyOtp threw", err);
      setError($errC, "No se pudo verificar el código. Intenta de nuevo.");
    } finally {
      setLoading($codeS, false);
    }
  });

  // -------- Resend / change email --------
  $resend.addEventListener("click", async () => {
    if ($resend.disabled) return;
    setError($errC, null);
    clearOtp();
    startResendCooldown(60);
    try {
      const { error } = await sendOtp(currentEmail);
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

  // -------- Auto-redirect on session (covers magic-link click fallback) --------
  (async () => {
    if (!window.kizSupabase) return;

    let { data } = await window.kizSupabase.auth.getSession();
    if (data?.session) { window.location.replace(nextUrl()); return; }

    const hash = window.location.hash || "";
    const query = window.location.search || "";
    const hasToken =
      /access_token|error_description/.test(hash) ||
      /[?&](code|token_hash|error)=/.test(query);
    if (hasToken) {
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
