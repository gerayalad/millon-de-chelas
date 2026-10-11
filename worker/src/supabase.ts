// RPC de Supabase desde el Worker con la llave publishable: las funciones ia_* exigen la
// clave_servidor (secret SERVER_KEY), así que no hace falta la service_role.

export interface Chela {
  id: number;
  creado: string;
  nombre: string;
  tipo: string;
  ml: number;
  cantidad: number;
  cuenta: number;
  numero: number | null;
  foto: string;
  mini: string | null;
  autor: string;
  estado: 'pendiente' | 'revision' | 'aprobada' | 'rechazada';
  orden: number | null;
  ia: Record<string, unknown> | null;
  jev: number | null;
  motivo: string | null;
  ia_intentos: number;
}

export interface SupabaseConfig {
  url: string;
  key: string;
}

export async function rpc<T>(config: SupabaseConfig, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${config.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Supabase ${fn} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Una función que regresa una fila puede mandar null o una fila con todo en null. */
export function fila(c: Chela | null): Chela | null {
  return c && typeof c.id === 'number' ? c : null;
}

/** Borra archivos del bucket de fotos (Storage API con la llave secreta: solo el Worker la tiene). */
export async function borrarFotos(config: SupabaseConfig, secreta: string, rutas: string[]): Promise<void> {
  if (rutas.length === 0) return;
  const res = await fetch(`${config.url}/storage/v1/object/fotos`, {
    method: 'DELETE',
    // Storage valida un JWT: va la service_role (las llaves sb_secret_ nuevas no son JWT y las rechaza).
    headers: { apikey: secreta, Authorization: `Bearer ${secreta}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: rutas }),
  });
  if (!res.ok) throw new Error(`Borrar fotos ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function descargarFoto(config: SupabaseConfig, ruta: string): Promise<ArrayBuffer> {
  const res = await fetch(`${config.url}/storage/v1/object/public/fotos/${ruta}`);
  if (!res.ok) throw new Error(`Foto ${ruta}: ${res.status}`);
  return res.arrayBuffer();
}
