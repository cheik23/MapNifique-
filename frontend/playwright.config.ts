import { defineConfig, devices } from '@playwright/test'

// Tests de non-régression cartographique. Chaque projet démarre son propre
// build + preview Vite : MapLibre (défaut) sur 4173, Leaflet sur 4174.
// Les tuiles et l'API sont interceptées dans le navigateur : aucun réseau
// externe, aucune base, aucune donnée réelle.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // En CI : liste lisible + rapport HTML publié en artefact (open: never).
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
      ]
    : [['list']],
  use: {
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      // WebGL logiciel : rendu canvas déterministe sans GPU.
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
    trace: 'retain-on-failure',
  },
  forbidOnly: !!process.env.CI,
  projects: [
    {
      name: 'maplibre',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:4173',
      },
    },
    {
      name: 'leaflet',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:4174',
      },
    },
  ],
  webServer: [
    {
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
    {
      command:
        'VITE_MAPNIFIQUE_MAP_ENGINE=leaflet npx vite build --outDir dist-leaflet --emptyOutDir && npx vite preview --outDir dist-leaflet --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
})
