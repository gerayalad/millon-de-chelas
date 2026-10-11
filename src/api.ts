// Todo lo que habla con Supabase (proyecto "chelas") y con el Worker (/api/revisar). Las
// escrituras pasan por funciones de la base que validan y mueven el marcador; ver
// supabase/migrations.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const BUCKET = 'fotos';

export type Estado = 'pendiente' | 'revision' | 'aprobada' | 'rechazada';

/** Lo que vio la IA (worker/src/vision.ts) más el veredicto de Jev sobre lo declarado. */
export interface InfoIA {
  resumen?: string;
  observacion?: string;
  marca?: string | null;
  estilo?: string | null;
  abv?: string | null;
  origen?: string | null;
  descripcion?: string | null;
  dato?: string | null;
  cantidad_visible?: number;
  envase?: string;
  ml_estimados?: number | null;
  cuadra?: number;
}

export interface Chela {
  id: number;
  creado: string;
  nombre: string;
  tipo: string;
  ml: number;
  cantidad: number;
  cuenta: number;
  /** Conteo colectivo con el que quedó (la última chela de la foto); null hasta aprobarse. */
  numero: number | null;
  foto: string;
  mini: string | null;
  autor: string;
  estado: Estado;
  orden: number | null;
  ia: InfoIA | null;
  jev?: number | null;
  motivo: string | null;
  decidio?: 'ia' | 'admin' | null;
}

export interface Marcador {
  total: number;
  meta: number;
}

export interface FilaRanking {
  nombre: string;
  chelas: number;
  fotos: number;
}

export interface FilaMarca {
  marca: string;
  estilo: string | null;
  chelas: number;
  fotos: number;
}

const MENSAJES: Record<string, string> = {
  nombre_invalido: 'Tu nombre chelero: de 3 a 20 letras o números, sin espacios (se vale _ y .).',
  nombre_tomado: 'Ese nombre chelero ya lo tiene alguien más. Prueba otro.',
  telefono_invalido: 'Ese teléfono no se ve bien: 10 dígitos, o con + y código de país.',
  sin_perfil: 'Primero crea tu nombre chelero.',
  suscripcion_invalida: 'No se pudieron activar los avisos en este navegador.',
  tipo_invalido: 'Elige qué te estás tomando.',
  no_cuenta: 'Menos de 250 ml no cuenta 😅',
  ml_invalido: '¿Más de 5 litros? Eso no es una chela, es un barril.',
  cantidad_invalida: 'Máximo 24 chelas por foto.',
  foto_invalida: 'La foto no se subió bien. Intenta otra vez.',
  foto_no_subida: 'La foto no se subió bien. Intenta otra vez.',
  muy_rapido: 'Tranquilo, campeón: espera un minuto para la siguiente.',
  bloqueado: 'Demasiados intentos con PIN equivocado. Espera 10 minutos.',
  total_invalido: 'Ese número no se vale.',
};

function mensaje(error: { message?: string; code?: string } | null | undefined): string {
  if (!error) return 'Algo falló. Intenta otra vez.';
  if (error.code === '23505') return 'Esa foto ya se había sumado.';
  const m = error.message ?? '';
  for (const clave of Object.keys(MENSAJES)) if (m.includes(clave)) return MENSAJES[clave]!;
  if (/fetch|network|Failed/i.test(m)) return 'Sin conexión. Revisa tu internet e intenta otra vez.';
  return 'Algo falló. Intenta otra vez.';
}

export class ErrorApi extends Error {}

/** Una función que regresa una fila puede mandar null o una fila con todo en null. */
function fila(c: Chela | null | undefined): Chela | null {
  return c && typeof c.id === 'number' ? c : null;
}

export async function leerMarcador(): Promise<Marcador> {
  const { data, error } = await supabase.from('marcador').select('total, meta').eq('id', 1).single();
  if (error || !data) throw new ErrorApi(mensaje(error));
  return data as Marcador;
}

/** Las aprobadas más recientes (por orden de aprobación); con `antesDe` (un orden), las anteriores. */
export async function leerChelas(antesDe?: number, limite = 24): Promise<Chela[]> {
  let q = supabase.from('chelas').select('*').eq('estado', 'aprobada').order('orden', { ascending: false }).limit(limite);
  if (antesDe !== undefined) q = q.lt('orden', antesDe);
  const { data, error } = await q;
  if (error) throw new ErrorApi(mensaje(error));
  return (data ?? []) as Chela[];
}

/** Una aprobada por id (null si no existe o no está aprobada). */
export async function leerChela(id: number): Promise<Chela | null> {
  const { data, error } = await supabase.from('chelas').select('*').eq('id', id).maybeSingle();
  if (error) throw new ErrorApi(mensaje(error));
  return fila(data as Chela | null);
}

/** De las que tengo en pantalla, cuáles siguen aprobadas (un admin pudo denegar alguna). */
export async function siguenAprobadas(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase.from('chelas').select('id').in('id', ids);
  if (error) throw new ErrorApi(mensaje(error));
  return new Set((data ?? []).map((f) => (f as { id: number }).id));
}

export function urlFoto(ruta: string): string {
  return supabase.storage.from(BUCKET).getPublicUrl(ruta).data.publicUrl;
}

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function subir(ruta: string, blob: Blob): Promise<void> {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(ruta, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw new ErrorApi(mensaje(error));
}

/** Sube la foto y su miniatura: AAAA-MM/uuid.jpg y AAAA-MM/uuid-mini.jpg. */
export async function subirFoto(foto: Blob, mini: Blob): Promise<{ foto: string; mini: string }> {
  const d = new Date();
  const base = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}/${uuid()}`;
  const rutas = { foto: `${base}.jpg`, mini: `${base}-mini.jpg` };
  await Promise.all([subir(rutas.foto, foto), subir(rutas.mini, mini)]);
  return rutas;
}

export async function registrar(datos: {
  nombre: string;
  tipo: string;
  ml: number;
  cantidad: number;
  foto: string;
  mini: string;
  secreto: string;
}): Promise<Chela> {
  const { data, error } = await supabase.rpc('registrar_chela', {
    p_nombre: datos.nombre,
    p_tipo: datos.tipo,
    p_ml: datos.ml,
    p_cantidad: datos.cantidad,
    p_foto: datos.foto,
    p_mini: datos.mini,
    p_secreto: datos.secreto,
  });
  const c = fila(data as Chela | null);
  if (error || !c) throw new ErrorApi(mensaje(error));
  return c;
}

/**
 * Pide al Worker que la IA revise la foto y espera el veredicto. null = sigue en proceso
 * (otro intento la está revisando o la IA falló y el cron la reintenta).
 */
export async function revisar(id: number): Promise<Chela | null> {
  try {
    const res = await fetch('/api/revisar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok && res.status !== 202) return null;
    const { chela } = (await res.json()) as { chela: Chela | null };
    return fila(chela);
  } catch {
    return null;
  }
}

/** Mis fotos recientes que no salen en el feed: pendientes, en revisión o rechazadas. */
export async function misRevisiones(secreto: string): Promise<Chela[]> {
  const { data, error } = await supabase.rpc('mis_revisiones', { p_secreto: secreto });
  if (error) throw new ErrorApi(mensaje(error));
  return (data ?? []) as Chela[];
}

export async function borrar(id: number, secreto: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('borrar_chela', { p_id: id, p_secreto: secreto });
  if (error) throw new ErrorApi(mensaje(error));
  return data === true;
}

export async function ranking(desde: Date | null): Promise<FilaRanking[]> {
  const { data, error } = await supabase.rpc('ranking', { p_desde: desde ? desde.toISOString() : null });
  if (error) throw new ErrorApi(mensaje(error));
  return ((data ?? []) as FilaRanking[]).map((f) => ({ ...f, chelas: Number(f.chelas), fotos: Number(f.fotos) }));
}

export async function rankingMarcas(desde: Date | null): Promise<FilaMarca[]> {
  const { data, error } = await supabase.rpc('ranking_marcas', { p_desde: desde ? desde.toISOString() : null });
  if (error) throw new ErrorApi(mensaje(error));
  return ((data ?? []) as FilaMarca[]).map((f) => ({ ...f, chelas: Number(f.chelas), fotos: Number(f.fotos) }));
}

// ───────── perfil (nombre chelero + teléfono opcional). acepta_promos queda en la base, siempre en
// false: no se pide consentimiento de promos por ahora.

export interface Perfil {
  nombre: string;
  telefono: string | null;
  acepta_promos: boolean;
}

/** Versión del aviso de privacidad que se acepta al guardar el perfil (privacidad.html). */
export const AVISO_VERSION = '2026-10-11';

export async function guardarPerfil(secreto: string, p: { nombre: string; telefono: string; aceptaPromos: boolean }): Promise<Perfil> {
  const { data, error } = await supabase.rpc('guardar_perfil', {
    p_secreto: secreto,
    p_nombre: p.nombre,
    p_telefono: p.telefono,
    p_acepta_promos: p.aceptaPromos,
    p_aviso: AVISO_VERSION,
  });
  if (error || !data) throw new ErrorApi(mensaje(error));
  return data as Perfil;
}

export async function miPerfil(secreto: string): Promise<Perfil | null> {
  const { data, error } = await supabase.rpc('mi_perfil', { p_secreto: secreto });
  if (error) throw new ErrorApi(mensaje(error));
  return (data as Perfil | null) ?? null;
}

export async function borrarPerfil(secreto: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('borrar_perfil', { p_secreto: secreto });
  if (error) throw new ErrorApi(mensaje(error));
  return data === true;
}

export async function nombreDisponible(nombre: string, secreto: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('nombre_disponible', { p_nombre: nombre, p_secreto: secreto });
  if (error) throw new ErrorApi(mensaje(error));
  return data === true;
}

// ───────── avisos push

export async function guardarSuscripcion(secreto: string, sub: PushSubscriptionJSON): Promise<void> {
  const { error } = await supabase.rpc('guardar_suscripcion', {
    p_secreto: secreto,
    p_endpoint: sub.endpoint,
    p_p256dh: sub.keys?.['p256dh'],
    p_auth: sub.keys?.['auth'],
  });
  if (error) throw new ErrorApi(mensaje(error));
}

export async function borrarSuscripcion(endpoint: string): Promise<void> {
  const { error } = await supabase.rpc('borrar_suscripcion', { p_endpoint: endpoint });
  if (error) throw new ErrorApi(mensaje(error));
}

// ───────── admin (PIN). Con PIN equivocado las funciones regresan null / vacío.

export async function adminEntrar(pin: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('admin_entrar', { p_pin: pin });
  if (error) throw new ErrorApi(mensaje(error));
  return data === true;
}

export async function adminConteos(pin: string): Promise<Partial<Record<Estado, number>> | null> {
  const { data, error } = await supabase.rpc('admin_conteos', { p_pin: pin });
  if (error) throw new ErrorApi(mensaje(error));
  return (data as Partial<Record<Estado, number>> | null) ?? null;
}

export async function adminListar(pin: string, estados: Estado[], antesDe?: number): Promise<Chela[]> {
  const { data, error } = await supabase.rpc('admin_listar', {
    p_pin: pin,
    p_estados: estados,
    p_antes: antesDe ?? null,
    p_limite: 30,
  });
  if (error) throw new ErrorApi(mensaje(error));
  return (data ?? []) as Chela[];
}

export async function adminDecidir(pin: string, id: number, decision: 'aprobada' | 'rechazada'): Promise<Chela | null> {
  const { data, error } = await supabase.rpc('admin_decidir', { p_pin: pin, p_id: id, p_decision: decision, p_motivo: null });
  if (error) throw new ErrorApi(mensaje(error));
  return fila(data as Chela | null);
}

export async function adminAjustarTotal(pin: string, total: number): Promise<number | null> {
  const { data, error } = await supabase.rpc('admin_ajustar_total', { p_pin: pin, p_total: total });
  if (error) throw new ErrorApi(mensaje(error));
  return data === null ? null : Number(data);
}

// ───────── tiempo real

export interface Escuchas {
  /** Una foto que se aprobó (o cambió estando aprobada). */
  aprobada(chela: Chela): void;
  borrada(id: number): void;
  marcador(m: Marcador): void;
  estado(conectado: boolean): void;
}

/**
 * Tiempo real. Por RLS solo llegan cambios de filas aprobadas: una foto aparece cuando pasa a
 * 'aprobada' (UPDATE). Si un admin deniega una ya aprobada no llega evento; baja el marcador y
 * el cliente revisa sus fotos con siguenAprobadas().
 */
export function escuchar(e: Escuchas): () => void {
  const canal = supabase
    .channel('chelas-en-vivo')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chelas' }, (p) => {
      const c = p.new as Chela;
      if (c.estado === 'aprobada') e.aprobada(c);
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chelas' }, (p) => {
      const id = (p.old as { id?: number }).id;
      if (typeof id === 'number') e.borrada(id);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'marcador' }, (p) =>
      e.marcador(p.new as Marcador),
    )
    .subscribe((status) => e.estado(status === 'SUBSCRIBED'));
  return () => {
    void supabase.removeChannel(canal);
  };
}
