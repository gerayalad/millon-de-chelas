// Secrets del Worker (wrangler secret put …; en local, .dev.vars). `wrangler types` no los ve.
interface Env {
  OPENROUTER_API_KEY: string;
  TYPESAFE_API_KEY: string;
  SERVER_KEY: string;
  VAPID_PRIVATE_JWK: string;
  SUPABASE_SECRET: string;
}
