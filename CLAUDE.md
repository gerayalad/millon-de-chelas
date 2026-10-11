# Millón de Chelas

App web para el grupo de WhatsApp "MILLÓN DE CERVEZAS": cada quien toma la foto de su chela, elige el tamaño y una IA la revisa; si es cerveza, recibe su número y suma al conteo colectivo hasta 1,000,000 (en vivo, con ranking de cheleros y de marcas). Inspirada en `../Archived/DiaDeMuertos` (odómetro, bottom sheets, tarjeta para compartir, Jev). El diseño (cartel crema/naranja, marcador de tablero, `public/brindis.svg`) lo hizo ChatGPT encima de la primera versión.

- **En vivo:** https://chela.happytohelp.mx, panel en `/admin`. **Hosting: Netlify** (sitio `millon-de-chelas`, equipo HappyToHelp, https://millon-de-chelas.netlify.app), ligado al repo público https://github.com/gerayalad/millon-de-chelas: cada push a `main` publica. Antes estuvo en un Worker de Cloudflare (ver historial de git).
- **Backend:** Supabase, proyecto `chelas` (`ymujpzomslehtsbjwugm`, org HTH, us-east-1). Esquema en `supabase/migrations/` (0001 base, 0002 revisión con IA y admin).

## Reglas del conteo (descripción del grupo)

250-599 ml = 1; desde 600 ml sube 1 cada 300 ml (600 = 2, 900 = 3, 1200 = 4); menos de 250 ml, 0% y otras bebidas no cuentan. Viven en **dos lugares** que deben coincidir: `public.chelas_por_ml` (la base, que manda) y `src/reglas.ts` (vista previa y tamaños predefinidos).

## Flujo de una foto

1. El cliente comprime la foto (1080 px) y una miniatura (640 px, `-mini.jpg`; la del álbum y la IA), las sube al bucket público `fotos` y llama `registrar_chela`: la fila queda `pendiente`, **sin número y sin sumar**.
2. Llama `POST /api/revisar {id}` (función de Netlify `netlify/functions/revisar.mts` → `servidor/`): `ia_tomar` (máx. 3 intentos, uno cada 90 s) → **visión** en OpenRouter (`vision.ts`, `OPENROUTER_MODEL`, JSON estricto: observación objetiva en inglés + marca/estilo/abv/origen/descripción/dato en español) → **Jev** (`jev.ts`, dos noul: ¿es cerveza válida? y ¿lo declarado cuadra?) → `decidir` (`revisar.ts`) → `ia_resolver`.
   - Jev no ve imágenes (su state es texto/JSON): por eso lee lo que describió el modelo de visión.
   - `es_cerveza ≥ JEV_APROBAR` (0.65) y `cuadra ≥ 0.3` → **aprobada**: `private.aprobar` asigna `numero` (marcador + cuenta) y `orden`. `≤ JEV_RECHAZAR` (0.2) → **se descarta**: `ia_descartar` borra la fila y la función borra la foto y la miniatura (Storage API con el secret `SUPABASE_SECRET`); no llega al admin. Solo lo que deniega un admin queda como `rechazada`. En medio, o si no cuadra → **revision** (admin).
   - Calibración (11/10/2026, `jev-1.13.0` + Sonnet 5.5, 7 fotos reales de Wikimedia Commons): no-cerveza 0.03-0.06 (café, refresco, dibujo, Heineken 0.0 — la visión lee el "0.0"), cervezas 0.93-0.98, michelada sin lata a la vista 0.68; "3 caguamas" con dos botellas → cuadra 0.02. La pregunta "cuadra" no compara envases (la chela se sirve en vaso) y acepta declarar de menos.
3. Si la función falla o tarda, la fila sigue `pendiente` (la app pregunta con `mi_chela`, que también da el "recibo" de lo descartado durante 30 min); el cron (`netlify/functions/cron.mts`, cada 2 min, `ia_pendientes`) la reintenta y tras 3 intentos pasa a `revision`.
4. El cliente muestra el resultado (escáner → ¡Salud! con número, ficha de la IA y tarjeta para el grupo / en revisión / rechazada). Tiempo real: por RLS el público solo ve `aprobada`; una foto aparece en todos cuando su UPDATE la vuelve aprobada. Si un admin deniega una aprobada no llega evento: baja el marcador y el cliente revisa sus fotos con `siguenAprobadas`.

## Perfil, PWA y avisos

- **Perfil** (`private.perfiles`, migraciones 0003-0004): **nombre chelero** único tipo username (3-20, letras/números/`_`/`.`, sin espacios, único sin mayúsculas) y teléfono opcional (10 dígitos → `+52…`). Se pide antes de la primera foto; `registrar_chela` toma el nombre del perfil (nadie sube a nombre de otro) y renombrar actualiza sus fotos. `acepta_promos` existe pero siempre va en false: no se pide consentimiento de promos (el aviso de privacidad dice que no se comparten datos; si un día se quiere, hay que pedirlo aparte).
- **Aviso de privacidad** en `/privacidad` (`privacidad.html`), responsable HappyToHelp, contacto hola@happytohelp.mx. `AVISO_VERSION` en `src/api.ts` se guarda con cada perfil.
- **PWA**: `public/sw.js` (instalable, copia ligera sin red, avisos), `public/manifest.webmanifest`, `src/pwa.ts` (guía de instalación por dispositivo: iPhone/Android/compu, `beforeinstallprompt`, tarjeta en la portada que, ya instalada, ofrece activar avisos). En iPhone los push solo funcionan con la app instalada (iOS 16.4+).
- **Avisos de metas** (solo eso): cada millar. El cron llama `push_hito` (marca `private.ajustes.ultimo_hito` y regresa las suscripciones) y `servidor/push.ts` manda push **vacíos** firmados con VAPID (`VAPID_PUBLIC` en `servidor/entorno.ts`, `VAPID_PRIVATE_JWK` secreto; la pública también en `.env` como `VITE_VAPID_PUBLIC`). El service worker pide el texto a `GET /api/aviso`. Endpoints muertos (404/410) se borran con `push_bajas`.
- **Íconos y vista previa**: `art/icono.svg` (la "M" del diseño), `art/icono-maskable.svg`, `art/badge.svg`, `art/og.svg` → `npm run icons`.
- **Marcador**: la cerveza (`#cerveza`) sube con el avance del tramo entre hitos (`llenarCerveza` en `main.ts`); al cruzar un hito se desborda y baja.

## Seguridad

- El cliente nunca escribe en tablas; todo por funciones `security definer`. El servidor se autentica con `private.ajustes.clave_servidor` (= secret `SERVER_KEY`), así que usa la llave publishable, no la service_role.
- Sin login: cada dispositivo tiene un secreto en localStorage; `autor` es su sha256 (borrar las propias, `mis_revisiones`).
- Admin con PIN de 6 dígitos (`private.ajustes.pin_admin`; copia local en `.admin-pin.local`). `private.pin_valido` registra fallos y bloquea 10 min tras 15; por eso las funciones `admin_*` regresan null/vacío con PIN malo (lanzar revertiría el registro del fallo).
- `/api/revisar`: solo desde `ALLOWED_ORIGINS` y con rate limit por IP (`rateLimit` en la config de la función).

## Comandos

`npm run dev` (solo Vite, sin `/api`) o `npm run dev:netlify` (`netlify dev` en el 8888: Vite + funciones, con las variables del sitio). `npm run build` (typecheck de la app y de `servidor/` + Vite, tres páginas: `index.html`, `admin.html`, `privacidad.html`), `npm run icons`. Publicar = `git push` a `main` (Netlify construye con `netlify.toml`).

- **Configuración pública** del servidor (Supabase, modelos, umbrales, orígenes, VAPID pública) en `servidor/entorno.ts` (las variables de `netlify.toml` no llegan a las funciones). **Secretos** como variables del sitio en Netlify: `OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `SERVER_KEY`, `VAPID_PRIVATE_JWK`, `SUPABASE_SECRET` (service_role JWT, solo para borrar archivos de lo rechazado). Copia local en `.dev.vars` (no se sube).
- Nunca subir `.dev.vars`, `*.local` (PIN de admin, llave VAPID), `supabase/.temp/`: el repo es público.
