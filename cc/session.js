// cc/session.js — resuelve cuando hay sesion Supabase.
//
// auth-guard.js fija window.kizUserEmail y JUSTO despues emite
// `kiz-session-ready` (auth-guard.js:204-205). Si no hay sesion, ese mismo
// guard ya redirige a /login, asi que aqui no hay ninguna decision de auth:
// solo se espera. El timeout evita que el shell se quede en blanco si el guard
// nunca corre (por ejemplo en la pagina de fixture, que lo stubbea).

let resolved = null;

export function ready(timeoutMs = 15000) {
  if (resolved) return resolved;
  resolved = new Promise((resolve) => {
    if (window.kizUserEmail) { resolve(window.kizUserEmail); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(window.kizUserEmail || null);
    };
    window.addEventListener('kiz-session-ready', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
  return resolved;
}

export function email() {
  return window.kizUserEmail || null;
}
