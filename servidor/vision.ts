// Paso 1: un modelo con visión (OpenRouter) mira la miniatura y regresa JSON con lo que ve.
// La parte objetiva (en inglés) es lo que lee Jev para decidir; la parte en español es lo que
// ve el grupo (marca, estilo, descripción y un dato curioso).

export interface Vision {
  /** Lo que hay en la foto, literal y en inglés: es el "state" que lee Jev. */
  observacion: string;
  /** Una línea en español: "Una lata de Coca-Cola sobre una mesa". */
  resumen: string;
  hay_bebida: boolean;
  sin_alcohol_visible: boolean;
  es_pantalla_o_dibujo: boolean;
  cantidad_visible: number;
  envase: 'lata' | 'botella' | 'caguama' | 'vaso' | 'tarro' | 'barril' | 'otro' | 'ninguno';
  ml_estimados: number | null;
  marca: string | null;
  estilo: string | null;
  abv: string | null;
  origen: string | null;
  descripcion: string | null;
  dato: string | null;
}

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'observacion',
    'resumen',
    'hay_bebida',
    'sin_alcohol_visible',
    'es_pantalla_o_dibujo',
    'cantidad_visible',
    'envase',
    'ml_estimados',
    'marca',
    'estilo',
    'abv',
    'origen',
    'descripcion',
    'dato',
  ],
  properties: {
    observacion: {
      type: 'string',
      description:
        'English. Literal, neutral description of everything relevant in the photo: every drink and container, readable label text, logos, liquid color, foam, how many there are, whether they look full/empty, and whether this is a real photo or a screen/print/drawing. No guesses about intent.',
    },
    resumen: { type: 'string', description: 'Español, máximo 12 palabras: qué se ve en la foto.' },
    hay_bebida: { type: 'boolean' },
    sin_alcohol_visible: {
      type: 'boolean',
      description: 'true only if a label visibly says 0.0, 0%, sin alcohol, non-alcoholic or similar.',
    },
    es_pantalla_o_dibujo: {
      type: 'boolean',
      description: 'true if the beer is shown on a phone/computer screen, a printed picture, a poster, a drawing or a render.',
    },
    cantidad_visible: { type: 'integer', description: 'How many beer containers/servings are visible (0 if none).' },
    envase: { type: 'string', enum: ['lata', 'botella', 'caguama', 'vaso', 'tarro', 'barril', 'otro', 'ninguno'] },
    ml_estimados: { type: ['integer', 'null'], description: 'Estimated ml of one container, null if unknown.' },
    marca: { type: ['string', 'null'], description: 'Brand and variant if identifiable (e.g. "Modelo Especial"), else null.' },
    estilo: { type: ['string', 'null'], description: 'Español: estilo (Lager, Pilsner, IPA, Stout, Ámbar, Michelada…), null si no hay cerveza.' },
    abv: { type: ['string', 'null'], description: 'Typical ABV of that beer, e.g. "4.5%", null if unknown.' },
    origen: { type: ['string', 'null'], description: 'Español: país / cervecería, null si no se sabe.' },
    descripcion: {
      type: ['string', 'null'],
      description: 'Español de México, tono de cuates, 1-2 frases: qué cerveza es y a qué sabe. null si no hay cerveza.',
    },
    dato: {
      type: ['string', 'null'],
      description: 'Español: un dato curioso y verdadero sobre esa cerveza o su estilo (máximo 2 frases). null si no hay cerveza.',
    },
  },
} as const;

const SISTEMA = `You review photos for a WhatsApp group in Mexico that is collectively counting beers to one million.
Describe exactly what you see; do not decide whether it counts. If you are not sure of the brand, use null instead of guessing.
Spanish fields must be in natural Mexican Spanish ("chela" is fine). Keep facts accurate; if you do not know a real fact, give a general one about the style.`;

export interface VisionConfig {
  apiKey: string;
  model: string;
  siteUrl: string;
}

function aBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Lanza si OpenRouter falla o responde algo que no es el JSON esperado. */
export async function verFoto(
  imagen: ArrayBuffer,
  declarado: { tipo: string; ml: number; cantidad: number },
  config: VisionConfig,
): Promise<Vision> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': config.siteUrl,
      'X-Title': 'Millon de Chelas',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: 'system', content: SISTEMA },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `The sender says this photo shows ${declarado.cantidad} × "${declarado.tipo}" (${declarado.ml} ml each). Describe the photo.`,
            },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${aBase64(imagen)}` } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'foto_chela', strict: true, schema: ESQUEMA } },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const texto = data.choices?.[0]?.message?.content ?? '';
  // Algunos proveedores envuelven el JSON en ```json … ```.
  const json = texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1);
  const v = JSON.parse(json) as Vision;
  if (typeof v.observacion !== 'string' || typeof v.hay_bebida !== 'boolean') throw new Error('OpenRouter: JSON incompleto');
  return v;
}
