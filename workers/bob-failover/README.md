# Worker de failover (R1)

Sirve los datos del dashboard desde el espejo **Cloudflare R2** cuando Supabase
Storage no responde. El espejo ya existe y el pipeline lo mantiene verificado en
cada ciclo (`upload_health.json` → `r2.parity_ok: true`); hasta ahora nadie lo
usaba.

**Privacidad idéntica a hoy:** el bucket sigue privado. El Worker exige un JWT
válido de Supabase **y** que el email esté en la whitelist. La firma se verifica
localmente (HS256), sin llamar a Supabase — por eso el respaldo sigue
funcionando justo cuando Supabase está caído.

**Coste: 0.** Workers gratis hasta 100.000 peticiones/día; R2 ya está en uso,
egress gratis, ~4 MB sobre 10 GB gratuitos.

---

## Despliegue (lo hace el owner — requiere su cuenta de Cloudflare)

Requisito: los datos ya se replican a R2 (hecho). Solo falta publicar el Worker.

```bash
npm install -g wrangler
wrangler login                      # abre el navegador con tu cuenta Cloudflare

cd "workers/bob-failover"

# 1) Secreto JWT de Supabase:
#    Supabase → Project Settings → API → JWT Settings → "JWT Secret"
wrangler secret put SUPABASE_JWT_SECRET

# 2) Emails autorizados (mismo contenido que la tabla public.allowed_emails)
wrangler secret put ALLOWED_EMAILS       # p.ej.: yoderiznaga21@gmail.com

# 3) Publicar
wrangler deploy
```

`wrangler deploy` imprime la URL del Worker, algo como
`https://bob-failover.<tu-subdominio>.workers.dev`.

## Activar el respaldo en el dashboard

Añadir esa URL a `config.js`:

```js
window.__KIZ_CONFIG__ = {
  ...,
  FAILOVER_URL: "https://bob-failover.<tu-subdominio>.workers.dev",
};
```

Mientras `FAILOVER_URL` no exista, el dashboard funciona exactamente igual que
hoy y el failover queda inactivo — activarlo es solo añadir esa línea.

## Comprobar que funciona

```bash
# 1) Salud del espejo (sin auth)
curl -s https://bob-failover.<sub>.workers.dev/health

# 2) Sin token debe rechazar
curl -s -o /dev/null -w "%{http_code}\n" \
  https://bob-failover.<sub>.workers.dev/snapshot.json      # espera 401

# 3) Prueba real: en el navegador, con el dashboard abierto, bloquea el host de
#    Supabase (DevTools → Network → Block request domain) y recarga.
#    Debe seguir mostrando el 100% de los datos con el aviso "modo respaldo".
```
