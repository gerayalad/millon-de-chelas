// GET /api/aviso → texto del aviso push de la última meta (lo pide public/sw.js al recibir el push).

import type { Config } from '@netlify/functions';
import { leerEntorno } from '../../servidor/entorno';
import { textoAviso } from '../../servidor/push';

export default async (): Promise<Response> => {
  let aviso = { title: '🍺 Millón de Chelas', body: '¡El grupo llegó a una nueva meta!', url: '/' };
  try {
    aviso = await textoAviso(leerEntorno(process.env));
  } catch (err) {
    console.error('aviso:', err);
  }
  return new Response(JSON.stringify(aviso), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
};

export const config: Config = { path: '/api/aviso', method: 'GET' };
