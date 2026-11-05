import { defineConfig } from 'vite';

export default defineConfig({
  // Chemins relatifs : indispensable pour un hébergement en sous-dossier
  // (GitHub Pages, Netlify, Vercel, etc.).
  base: './',

  server: {
    // Port fixe : évite que le serveur glisse sur 5174 et laisse le client
    // HMR pointer vers un port mort ("[vite] failed to connect to websocket").
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // URL du WebSocket HMR explicite : elle doit correspondre exactement au
    // serveur réellement écoutant, quel que soit le nom d'hôte utilisé.
    hmr: {
      protocol: 'ws',
      host: '127.0.0.1',
      port: 5173,
    },
    watch: {
      // dist/ est conservé : inutile de le surveiller (évite des reloads en boucle).
      ignored: ['**/dist/**'],
    },
  },
});
