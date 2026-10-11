import { defineConfig } from 'vite';

export default defineConfig({
  // /api (revisión con IA) va a `npm run dev:api` (wrangler dev en el 8787).
  server: { host: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // Tres páginas: la app, el panel de admin (/admin) y el aviso de privacidad (/privacidad).
    rollupOptions: { input: { main: 'index.html', admin: 'admin.html', privacidad: 'privacidad.html' } },
  },
});
