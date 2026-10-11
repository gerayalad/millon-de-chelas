// Configuración del servidor (funciones de Netlify). Lo público va aquí, versionado; los secretos
// llegan como variables de entorno del sitio en Netlify (en local, .dev.vars vía `netlify dev`).
// Nota: las variables de netlify.toml NO llegan a las funciones en tiempo de ejecución.

const PUBLICO = {
  SUPABASE_URL: 'https://ymujpzomslehtsbjwugm.supabase.co',
  SUPABASE_KEY: 'sb_publishable_-Rbwmhvfe53m0aW5hJmZiw_wCVtBIMu',
  SITE_URL: 'https://chela.happytohelp.mx',
  // Orígenes que pueden llamar /api/revisar, separados por comas. Vacío = cualquiera.
  ALLOWED_ORIGINS: 'https://chela.happytohelp.mx,https://millon-de-chelas.netlify.app',
  // Modelo con visión en OpenRouter. Más barato: "anthropic/claude-haiku-5.5".
  OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5',
  JEV_MODEL: 'jev-1.13.0',
  // Probabilidad (Jev) de que sea cerveza: ≥ APROBAR se aprueba sola, ≤ RECHAZAR se descarta
  // (ni se guarda); en medio la revisa un admin en /admin. Calibrado con fotos reales
  // (11/10/2026): no-cerveza 0.03-0.06, cervezas 0.93-0.98, michelada sin lata a la vista 0.68.
  JEV_APROBAR: '0.65',
  JEV_RECHAZAR: '0.2',
  // Llave pública VAPID de los avisos push (la privada es el secreto VAPID_PRIVATE_JWK). La misma
  // va en .env como VITE_VAPID_PUBLIC.
  VAPID_PUBLIC: 'BPpEdKiWFV2upB9_TohvnZTWdttsONnF94Ll55yr_lMIVtI1-kqo9TEERPR7ETzpZAVaipJsygco5MnVtNQ6fo4',
};

/** Secretos: OPENROUTER_API_KEY, TYPESAFE_API_KEY, SERVER_KEY (= private.ajustes.clave_servidor),
 *  VAPID_PRIVATE_JWK y SUPABASE_SECRET (service_role, JWT; solo para borrar archivos rechazados). */
const SECRETOS = ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'SERVER_KEY', 'VAPID_PRIVATE_JWK', 'SUPABASE_SECRET'] as const;

export type Entorno = { [K in keyof typeof PUBLICO]: string } & { [K in (typeof SECRETOS)[number]]: string };

/** Lo público se puede sobrescribir con una variable del mismo nombre; los secretos son obligatorios. */
export function leerEntorno(fuente: Record<string, string | undefined>): Entorno {
  const faltan = SECRETOS.filter((k) => !fuente[k]);
  if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
  const env: Record<string, string> = { ...PUBLICO };
  for (const k of [...Object.keys(PUBLICO), ...SECRETOS]) {
    const v = fuente[k];
    if (v !== undefined && v !== '') env[k] = v;
  }
  return env as Entorno;
}
