// POST /api/revisar {id} → la IA revisa la foto (servidor/revisar.ts) y responde la fila ya
// decidida. Si no termina (otro intento la tiene, o falla la IA), responde 202 y la app pregunta
// el resultado con mi_chela; el cron la reintenta.

import type { Config } from '@netlify/functions';
import { leerEntorno, type Entorno } from '../../servidor/entorno';
import { revisar } from '../../servidor/revisar';
import type { Chela } from '../../servidor/supabase';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function origenPermitido(req: Request, env: Entorno): boolean {
  const permitidos = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return permitidos.length === 0 || permitidos.includes(req.headers.get('Origin') ?? '');
}

/** Lo que la app necesita de la fila. */
function publica(c: Chela | null) {
  if (!c) return null;
  const { id, estado, numero, cuenta, nombre, tipo, ml, cantidad, foto, mini, ia, motivo, creado, orden, autor } = c;
  return { id, estado, numero, cuenta, nombre, tipo, ml, cantidad, foto, mini, ia, motivo, creado, orden, autor };
}

export default async (req: Request): Promise<Response> => {
  const env = leerEntorno(process.env);
  if (!origenPermitido(req, env)) return json({ error: 'origen' }, 403);
  let id: unknown;
  try {
    ({ id } = (await req.json()) as { id?: unknown });
  } catch {
    return json({ error: 'json' }, 400);
  }
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return json({ error: 'id' }, 400);
  try {
    const chela = await revisar(id, env);
    return json({ chela: publica(chela) }, chela ? 200 : 202);
  } catch (err) {
    console.error('revisar:', err);
    return json({ chela: null }, 202);
  }
};

export const config: Config = {
  path: '/api/revisar',
  method: 'POST',
  // Por IP (alto por el CGNAT de los celulares). Cada foto se revisa a lo más 3 veces de todos modos.
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
