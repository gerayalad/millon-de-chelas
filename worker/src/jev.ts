// Paso 2: Jev (TypeSafe AI) decide con lo que describió el modelo de visión. Jev no ve
// imágenes (su "state" es texto o JSON), así que lee la observación objetiva + lo declarado.
// Dos preguntas sí/no ("noul") en una llamada: si es cerveza válida para el conteo y si lo
// declarado (cuántas y de qué tamaño) cuadra con la foto.

import { noul, RateLimitError, TypeSafeClient } from '@typesafe-ai/sdk';
import type { Vision } from './vision';

export const PREGUNTAS = {
  es_cerveza: noul(
    'A member of a beer-counting group sent this photo as proof of a beer they are drinking. Based on the description of the photo, does it show at least one real alcoholic beer?',
    {
      true: 'Yes: a real photo of beer — a can, bottle, caguama, glass or mug of beer, a michelada or chelada made with beer — even if partly drunk, the brand is unknown, or other things are also in the picture.',
      false:
        'No: no beer at all; only non-alcoholic / 0.0% beer; soda, water, juice, wine, spirits or cocktails without beer; or the beer is only on a screen, printed picture, poster, drawing or render.',
    },
  ),
  cuadra: noul(
    'The sender declared how many beers the photo shows and roughly how many ml each one has. Is that plausible given the description? The container type does not matter: beer is often poured into glasses, cups or mugs.',
    {
      true: 'Yes: about as many beers as declared and about as big, or more / bigger (declaring less is fine). Estimates are rough; partly drunk, partly hidden or poured beers count.',
      false: 'No: clearly fewer beers than declared, or clearly much smaller than declared (for example 3 × 940 ml declared but only two 355 ml bottles visible).',
    },
  ),
};

export interface JevConfig {
  apiKey: string;
  model: string;
}

export class JevRateLimited extends Error {}

let cache: { clave: string; cliente: TypeSafeClient } | null = null;

function cliente(config: JevConfig): TypeSafeClient {
  const clave = `${config.apiKey}\u0000${config.model}`;
  if (cache?.clave !== clave) {
    cache = {
      clave,
      cliente: new TypeSafeClient({
        apiKey: config.apiKey,
        defaultModel: config.model,
        timeout: 8000,
        retry: { maxRetries: 1, backoffMaxMs: 1500, maxRetryAfterMs: 3000 },
        logLevel: 'off',
      }),
    };
  }
  return cache.cliente;
}

export interface Veredicto {
  /** Probabilidad de que sea una cerveza válida. */
  esCerveza: number;
  /** Probabilidad de que lo declarado cuadre con la foto. */
  cuadra: number;
}

function prob(v: number, etiqueta: string): number {
  if (!(v >= 0 && v <= 1)) throw new Error(`Jev devolvió una probabilidad inválida (${etiqueta}): ${String(v)}`);
  return v;
}

export async function preguntarJev(
  vision: Vision,
  declarado: { tipo: string; ml: number; cantidad: number },
  config: JevConfig,
): Promise<Veredicto> {
  try {
    const { answers } = await cliente(config).systemOne({
      state: {
        photo_description: vision.observacion,
        observations: {
          has_drink: vision.hay_bebida,
          non_alcoholic_label_visible: vision.sin_alcohol_visible,
          on_screen_or_drawing: vision.es_pantalla_o_dibujo,
          beer_containers_visible: vision.cantidad_visible,
          container: vision.envase,
          estimated_ml_each: vision.ml_estimados,
          brand: vision.marca,
          style_guess: vision.estilo,
        },
        declared: { quantity: declarado.cantidad, ml_each: declarado.ml },
      },
      questions: PREGUNTAS,
    });
    return { esCerveza: prob(answers.es_cerveza.noul, 'es_cerveza'), cuadra: prob(answers.cuadra.noul, 'cuadra') };
  } catch (err) {
    if (err instanceof RateLimitError) throw new JevRateLimited('Jev: rate limit', { cause: err });
    throw err;
  }
}
