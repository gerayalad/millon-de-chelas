// Cada 2 minutos: revisa lo que quedó pendiente (la app se cerró o la IA falló) y, si el marcador
// cruzó un nuevo millar, manda el aviso push de la meta. Las programadas tienen 30 s: todo en paralelo.

import type { Config } from '@netlify/functions';
import { leerEntorno } from '../../servidor/entorno';
import { avisarHito } from '../../servidor/push';
import { revisarPendientes } from '../../servidor/revisar';

export default async (): Promise<void> => {
  const env = leerEntorno(process.env);
  await Promise.all([
    revisarPendientes(env).catch((err) => console.error('cron revisar:', err)),
    avisarHito(env).catch((err) => console.error('cron avisos:', err)),
  ]);
};

export const config: Config = { schedule: '*/2 * * * *' };
