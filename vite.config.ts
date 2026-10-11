import { defineConfig } from 'vite';

export default defineConfig({
  // Con /api (funciones): `npm run dev:netlify` (netlify dev, en el 8888, levanta Vite y las funciones).
  server: { host: true },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // Tres páginas: la app, el panel de admin (/admin) y el aviso de privacidad (/privacidad).
    rollupOptions: { input: { main: 'index.html', admin: 'admin.html', privacidad: 'privacidad.html' } },
  },
});
