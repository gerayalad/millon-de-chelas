// Avisos push de metas del grupo (cada 1,000 chelas).
// Se mandan SIN payload: el service worker (public/sw.js), al recibir el push, pide el texto a
// /api/aviso. Así no hay que cifrar el mensaje (RFC 8291); solo firmar VAPID (RFC 8292, ES256).

import { rpc, type SupabaseConfig } from './supabase';

const enc = new TextEncoder();

function b64url(datos: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof datos === 'string' ? enc.encode(datos) : new Uint8Array(datos);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let llave: { jwk: string; key: CryptoKey } | null = null;

async function llavePrivada(jwk: string): Promise<CryptoKey> {
  if (llave?.jwk !== jwk) {
    const key = await crypto.subtle.importKey('jwk', JSON.parse(jwk) as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    llave = { jwk, key };
  }
  return llave.key;
}

/** JWT VAPID para el servicio de push de `audiencia` (su origen), válido 12 h. */
async function jwtVapid(audiencia: string, env: Env): Promise<string> {
  const cabeza = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const datos = b64url(
    JSON.stringify({ aud: audiencia, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:hola@happytohelp.mx' }),
  );
  // WebCrypto firma ECDSA en formato r||s (64 bytes), que es justo el que pide JWS.
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await llavePrivada(env.VAPID_PRIVATE_JWK), enc.encode(`${cabeza}.${datos}`));
  return `${cabeza}.${datos}.${b64url(firma)}`;
}

/** Manda un push vacío a cada endpoint. Regresa los que el servicio dio por muertos (404/410). */
export async function enviarPush(endpoints: string[], env: Env): Promise<{ enviados: number; bajas: string[] }> {
  const jwts = new Map<string, Promise<string>>();
  const bajas: string[] = [];
  let enviados = 0;
  const uno = async (endpoint: string): Promise<void> => {
    const origen = new URL(endpoint).origin;
    if (!jwts.has(origen)) jwts.set(origen, jwtVapid(origen, env));
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          TTL: String(24 * 3600),
          Urgency: 'normal',
          Topic: 'meta',
          Authorization: `vapid t=${await jwts.get(origen)!}, k=${env.VAPID_PUBLIC}`,
          'Content-Length': '0',
        },
      });
      if (res.status === 404 || res.status === 410) bajas.push(endpoint);
      else if (res.ok) enviados++;
      else console.error(`push ${origen}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      console.error(`push ${origen}:`, err);
    }
  };
  // De 20 en 20 para no abrir cientos de conexiones a la vez.
  for (let i = 0; i < endpoints.length; i += 20) await Promise.all(endpoints.slice(i, i + 20).map(uno));
  return { enviados, bajas };
}

/** Cron: si el marcador cruzó un nuevo millar, avisa a todos los suscritos. */
export async function avisarHito(env: Env): Promise<void> {
  const sb: SupabaseConfig = { url: env.SUPABASE_URL, key: env.SUPABASE_KEY };
  const r = await rpc<{ hito: number; total: number; endpoints: string[] } | null>(sb, 'push_hito', { p_clave: env.SERVER_KEY });
  if (!r || r.endpoints.length === 0) return;
  const { enviados, bajas } = await enviarPush(r.endpoints, env);
  console.log(`meta ${r.hito}: ${enviados} avisos, ${bajas.length} bajas`);
  if (bajas.length) await rpc(sb, 'push_bajas', { p_clave: env.SERVER_KEY, p_endpoints: bajas });
}

const NUM = new Intl.NumberFormat('es-MX');

/** Texto del aviso (lo pide el service worker al recibir el push). */
export async function textoAviso(env: Env): Promise<{ title: string; body: string; url: string }> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/marcador?id=eq.1&select=total,meta`, {
    headers: { apikey: env.SUPABASE_KEY },
  });
  const [m] = (await res.json()) as { total: number; meta: number }[];
  const total = m?.total ?? 0;
  const meta = m?.meta ?? 1_000_000;
  const hito = Math.floor(total / 1000) * 1000;
  return {
    title: `🎉 ¡Llegamos a ${NUM.format(hito)} chelas!`,
    body: `Vamos en ${NUM.format(total)}. Faltan ${NUM.format(Math.max(0, meta - total))} para el millón. ¡Salud! 🍻`,
    url: '/',
  };
}
