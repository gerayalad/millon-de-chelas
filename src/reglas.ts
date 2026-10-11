// Reglas del grupo (descripción de WhatsApp). La misma cuenta vive en la base
// (public.chelas_por_ml): si cambian las reglas, cambiar las dos.
//   · Menos de 250 ml no cuenta
//   · 250-599 ml = 1
//   · Desde 600 ml sube 1 cada 300 ml (600 = 2, 900 = 3, 1200 = 4)

export const META = 1_000_000;
export const ML_MIN = 250;
export const ML_MAX = 5000;
export const CANTIDAD_MAX = 24;

export function chelasPorMl(ml: number): number {
  if (!Number.isFinite(ml) || ml < ML_MIN) return 0;
  if (ml < 600) return 1;
  return Math.floor(ml / 300);
}

export interface Tamano {
  id: string;
  nombre: string;
  ml: number;
  emoji: string;
}

export const TAMANOS: readonly Tamano[] = [
  { id: 'lata', nombre: 'Lata / botella', ml: 355, emoji: '🍺' },
  { id: 'media', nombre: 'Media / tallboy', ml: 473, emoji: '🥫' },
  { id: 'concierto', nombre: 'Vaso de concierto', ml: 700, emoji: '🥤' },
  { id: 'caguama', nombre: 'Caguama', ml: 940, emoji: '🍾' },
  { id: 'caguamon', nombre: 'Caguamón', ml: 1200, emoji: '🛢️' },
];

export function formatoMl(ml: number): string {
  return ml >= 1000 ? `${(ml / 1000).toLocaleString('es-MX', { maximumFractionDigits: 2 })} L` : `${ml} ml`;
}

/** Siguiente meta "redonda": 10,000, 25,000, 50,000, 100,000, 250,000… hasta el millón. */
export function siguienteMeta(total: number): { desde: number; hasta: number } {
  const metas = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 150_000, 200_000, 250_000];
  for (let m = 300_000; m <= META; m += 100_000) metas.push(m);
  let desde = 0;
  for (const m of metas) {
    if (total < m) return { desde, hasta: m };
    desde = m;
  }
  return { desde: META, hasta: META };
}
