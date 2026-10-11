// Revisión de una foto: tomarla (ia_tomar) → visión (OpenRouter) → Jev → decidir → ia_resolver.
// Lo que Jev rechaza no se guarda: ia_descartar borra la fila y aquí se borran los archivos.
// Si algo falla, la foto sigue 'pendiente' y el cron la reintenta (máximo 3 intentos; luego
// pasa a revisión del admin).

import { preguntarJev, type Veredicto } from './jev';
import { borrarFotos, descargarFoto, fila, rpc, type Chela } from './supabase';
import { verFoto, type Vision } from './vision';

export type Decision = 'aprobada' | 'rechazada' | 'revision';

/** Bajo esto, lo declarado no cuadra (calibrado: "3 caguamas" con una lata da 0.02; una
 *  michelada o un vaso sin marca, ~0.5). */
const CUADRA_MIN = 0.3;

export interface Umbrales {
  /** esCerveza ≥ aprobar (y lo declarado cuadra) → se aprueba sola. */
  aprobar: number;
  /** esCerveza ≤ rechazar → se rechaza sola. En medio, la revisa un admin. */
  rechazar: number;
}

export function decidir(vision: Vision, v: Veredicto, u: Umbrales): { decision: Decision; motivo: string | null } {
  if (v.esCerveza <= u.rechazar) return { decision: 'rechazada', motivo: `No parece cerveza: ${vision.resumen}` };
  if (v.esCerveza < u.aprobar) return { decision: 'revision', motivo: 'La IA no está segura de que sea cerveza' };
  if (v.cuadra < CUADRA_MIN) return { decision: 'revision', motivo: 'Lo declarado no cuadra con la foto (cantidad o tamaño)' };
  return { decision: 'aprobada', motivo: null };
}

function config(env: Env) {
  return {
    sb: { url: env.SUPABASE_URL, key: env.SUPABASE_KEY },
    vision: { apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL, siteUrl: env.SITE_URL },
    jev: { apiKey: env.TYPESAFE_API_KEY, model: env.JEV_MODEL },
    umbrales: { aprobar: Number(env.JEV_APROBAR), rechazar: Number(env.JEV_RECHAZAR) },
  };
}

/** null = no le tocaba (ya la tomó otro intento o ya se decidió) o falló y queda para el cron. */
export async function revisar(id: number, env: Env): Promise<Chela | null> {
  const c = config(env);
  const tomada = fila(await rpc<Chela | null>(c.sb, 'ia_tomar', { p_clave: env.SERVER_KEY, p_id: id }));
  if (!tomada) return null;
  const declarado = { tipo: tomada.tipo, ml: tomada.ml, cantidad: tomada.cantidad };
  try {
    const imagen = await descargarFoto(c.sb, tomada.mini ?? tomada.foto);
    const vision = await verFoto(imagen, declarado, c.vision);
    const veredicto = await preguntarJev(vision, declarado, c.jev);
    const { decision, motivo } = decidir(vision, veredicto, c.umbrales);
    if (decision === 'rechazada') {
      const r = await rpc<{ borrada: boolean; fila: Chela | null }>(c.sb, 'ia_descartar', {
        p_clave: env.SERVER_KEY,
        p_id: id,
        p_motivo: motivo,
      });
      if (r.borrada && r.fila) {
        await borrarFotos(c.sb, env.SUPABASE_SECRET, [r.fila.foto, r.fila.mini].filter((x): x is string => !!x)).catch(
          (err) => console.error(`borrar fotos ${id}:`, err),
        );
      }
      return fila(r.fila);
    }
    const ia = { ...vision, cuadra: veredicto.cuadra, modelo: env.OPENROUTER_MODEL, jev_modelo: env.JEV_MODEL };
    return fila(
      await rpc<Chela | null>(c.sb, 'ia_resolver', {
        p_clave: env.SERVER_KEY,
        p_id: id,
        p_decision: decision,
        p_ia: ia,
        p_jev: veredicto.esCerveza,
        p_motivo: motivo,
      }),
    );
  } catch (err) {
    console.error(`revisar ${id} (intento ${tomada.ia_intentos}):`, err);
    return null;
  }
}

/** Cron: lo que quedó pendiente (el cliente se fue antes, o falló la IA). */
export async function revisarPendientes(env: Env): Promise<void> {
  const ids = await rpc<number[]>(config(env).sb, 'ia_pendientes', { p_clave: env.SERVER_KEY });
  for (const id of ids) await revisar(id, env);
}
