// Un solo Worker: sirve la app (dist/) y la API en /api/* (mismo origen, sin CORS).
//   POST /api/revisar {id} → revisa la foto con IA y responde la fila ya decidida.
//   GET /api/aviso → texto del aviso push de la última meta (lo pide public/sw.js).
//   Cron cada minuto → reintenta lo que quedó pendiente y avisa si se cruzó un millar.
// La liga vieja (chelas.happytohelp.mx) redirige a SITE_URL.

import { avisarHito, textoAviso } from './push';
import { revisar, revisarPendientes } from './revisar';

/** Ligas anteriores que redirigen al dominio de SITE_URL. */
const DOMINIOS_VIEJOS = new Set(['chelas.happytohelp.mx']);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function origenPermitido(req: Request, env: Env): boolean {
  const permitidos = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (permitidos.length === 0) return true;
  return permitidos.includes(req.headers.get('Origin') ?? '');
}

/** Lo que el cliente necesita de la fila (sin el hash del autor ni datos internos). */
function publica(c: Awaited<ReturnType<typeof revisar>>) {
  if (!c) return null;
  const { id, estado, numero, cuenta, nombre, tipo, ml, cantidad, foto, mini, ia, motivo, creado, orden, autor } = c;
  return { id, estado, numero, cuenta, nombre, tipo, ml, cantidad, foto, mini, ia, motivo, creado, orden, autor };
}

async function revisarHttp(req: Request, env: Env): Promise<Response> {
  if (!origenPermitido(req, env)) return json({ error: 'origen' }, 403);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
  const { success } = await env.REVISAR_LIMIT.limit({ key: ip });
  if (!success) return json({ error: 'muy_rapido' }, 429);

  let id: unknown;
  try {
    ({ id } = (await req.json()) as { id?: unknown });
  } catch {
    return json({ error: 'json' }, 400);
  }
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return json({ error: 'id' }, 400);

  const chela = await revisar(id, env);
  // null: otro intento la está revisando, ya estaba decidida o falló (el cron la reintenta).
  return json({ chela: publica(chela) }, chela ? 200 : 202);
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (DOMINIOS_VIEJOS.has(url.hostname)) {
      return Response.redirect(`${new URL(env.SITE_URL).origin}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname === '/api/revisar') {
      if (req.method !== 'POST') return json({ error: 'metodo' }, 405);
      try {
        return await revisarHttp(req, env);
      } catch (err) {
        console.error('revisar:', err);
        return json({ chela: null }, 202);
      }
    }
    if (url.pathname === '/api/aviso') {
      try {
        return json(await textoAviso(env));
      } catch {
        return json({ title: '🍺 Millón de Chelas', body: '¡El grupo llegó a una nueva meta!', url: '/' });
      }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'no_encontrado' }, 404);
    return env.ASSETS.fetch(req);
  },

  async scheduled(_evento, env, ctx): Promise<void> {
    ctx.waitUntil(
      Promise.all([
        revisarPendientes(env).catch((err) => console.error('cron revisar:', err)),
        avisarHito(env).catch((err) => console.error('cron avisos:', err)),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
