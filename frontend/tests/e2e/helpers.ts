import { PNG } from 'pngjs'
import type { Page, Route } from '@playwright/test'

// Les lieux ci-dessous sont des fixtures de test : ils n'existent pas et ne
// doivent jamais être intégrés à la base de données ni à l'application publique.
export type MockPlace = {
  id: string
  name: string
  brand: string
  brand_key: string
  category: string
  lat: number
  lon: number
  address: string
  distance_m: number
}

export const FAR_PLACES: MockPlace[] = [
  {
    id: 'e2e-boulangerie-1',
    name: 'Boulangerie Mélody',
    brand: 'Boulangerie Mélody',
    brand_key: 'boulangerie-melody',
    category: 'Boulangerie',
    lat: 48.8566,
    lon: 2.3522,
    address: '1 rue de Test, Paris',
    distance_m: 120,
  },
  {
    id: 'e2e-pharmacie-2',
    name: 'Pharmacie Centrale',
    brand: 'Pharmacie Centrale',
    brand_key: 'pharmacie-centrale',
    category: 'Pharmacie',
    lat: 48.8606,
    lon: 2.3562,
    address: '2 rue de Test, Paris',
    distance_m: 550,
  },
  {
    id: 'e2e-supermarche-3',
    name: 'Supermarché du Parc',
    brand: 'Supermarché du Parc',
    brand_key: 'supermarche-du-parc',
    category: 'Supermarché',
    lat: 48.8526,
    lon: 2.3482,
    address: '3 rue de Test, Paris',
    distance_m: 560,
  },
  {
    id: 'e2e-librairie-4',
    name: 'Librairie Horizon',
    brand: 'Librairie Horizon',
    brand_key: 'librairie-horizon',
    category: 'Librairie',
    lat: 48.8616,
    lon: 2.3452,
    address: '4 rue de Test, Paris',
    distance_m: 850,
  },
  {
    id: 'e2e-restaurant-5',
    name: 'Restaurant Bellevue',
    brand: 'Restaurant Bellevue',
    brand_key: 'restaurant-bellevue',
    category: 'Restaurant',
    lat: 48.8516,
    lon: 2.3582,
    address: '5 rue de Test, Paris',
    distance_m: 700,
  },
]

// Commerce ajouté dans le scénario « nouvelle recherche ».
export const NEW_PLACES: MockPlace[] = [
  {
    id: 'e2e-fromagerie-6',
    name: 'Fromagerie Nouvelle',
    brand: 'Fromagerie Nouvelle',
    brand_key: 'fromagerie-nouvelle',
    category: 'Épicerie',
    lat: 48.8601,
    lon: 2.3411,
    address: '6 rue de Test, Paris',
    distance_m: 900,
  },
  {
    id: 'e2e-fleuriste-7',
    name: 'Fleuriste Aurore',
    brand: 'Fleuriste Aurore',
    brand_key: 'fleuriste-aurore',
    category: 'Fleuriste',
    lat: 48.8521,
    lon: 2.3611,
    address: '7 rue de Test, Paris',
    distance_m: 800,
  },
  {
    id: 'e2e-epicerie-8',
    name: 'Épicerie du Marché',
    brand: 'Épicerie du Marché',
    brand_key: 'epicerie-du-marche',
    category: 'Supermarché',
    lat: 48.8581,
    lon: 2.3681,
    address: '8 rue de Test, Paris',
    distance_m: 1100,
  },
]

// Cinq commerces rapprochés (moins de 30 m) : les deux moteurs doivent les
// regrouper volontairement à zoom faible.
export const CLOSE_PLACES: MockPlace[] = FAR_PLACES.map((place, index) => ({
  ...place,
  lat: 48.8566 + index * 0.00018,
  lon: 2.3522 + index * 0.00025,
  distance_m: 40 + index * 6,
}))

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function selectRows(searchParams: URLSearchParams): MockPlace[] {
  const query = (searchParams.get('q') || '').trim()
  const category = (searchParams.get('category') || '').trim()

  if (query === 'proches') return CLOSE_PLACES
  if (query === 'nouvelle') return NEW_PLACES
  if (query === 'aucun') return []

  let rows = FAR_PLACES
  if (category && category !== 'Tout') {
    const wanted = normalize(category)
    rows = rows.filter((place) => normalize(place.category).includes(wanted))
  }
  return rows
}

const EMPTY_OFFERS = {
  storeOffers: [],
  brandOffers: [],
  onlineOffers: [],
  cashbackOffers: [],
}

// Tuile neutre générée localement : 256×256 blanc, sans requête externe.
const NEUTRAL_TILE_PNG = PNG.sync.write(
  new PNG({ width: 256, height: 256 }),
)

// Style minimal déterministe : fond blanc, aucune tuile externe. Les erreurs
// de glyphes du calque de comptage de clusters sont attendues et tolérées.
const MOCK_STYLE = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'e2e-background',
      type: 'background',
      paint: { 'background-color': '#ffffff' },
    },
  ],
}

function json(route: Route, payload: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  })
}

/**
 * Masque les superpositions d'interface (note, boutons flottants,
 * attribution) qui peuvent recouvrir des pastilles selon la caméra. La barre
 * de catégories reste visible (les tests de filtre cliquent ses chips) ; le
 * recadrage de l'analyse exclut sa zone. Caché uniquement côté test : aucun
 * fichier applicatif n'est modifié.
 */
export async function hideMapOverlays(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      .map-top-note,
      .map-floating-controls,
      .maplibregl-ctrl-attrib,
      .leaflet-control-attribution {
        display: none !important;
      }
    `,
  })
}

/** Installe les interceptions réseau déterministes (API, style, tuiles). */
export async function installMockRoutes(page: Page): Promise<void> {
  await page.route('**/api/search/intelligent**', (route) => {
    const url = new URL(route.request().url())
    return json(route, {
      mode: url.searchParams.get('mode') || 'smart',
      places: selectRows(url.searchParams),
    })
  })

  await page.route('**/api/offers**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/api/offers/brands')) {
      return json(route, { brands: [] })
    }
    return json(route, EMPTY_OFFERS)
  })

  await page.route('**/api/discover**', (route) => json(route, { places: [] }))

  await page.route('**tiles.openfreemap.org/**', (route) =>
    json(route, MOCK_STYLE),
  )

  await page.route('**tile.openstreetmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: NEUTRAL_TILE_PNG,
    }),
  )
}

export type Blob = { x: number; y: number; area: number }

export type ColorBlobs = { color: string; blobs: Blob[] }

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

/**
 * Compte les zones connexes d'une couleur donnée dans une capture PNG.
 * Utilisé pour vérifier les pastilles réellement dessinées par MapLibre sur
 * son canvas WebGL : le DOM ne contient pas les points de la carte.
 */
export function findColorBlobs(
  png: PNG,
  hex: string,
  tolerance = 24,
  minArea = 150,
): Blob[] {
  const [tr, tg, tb] = hexToRgb(hex)
  const width = png.width
  const height = png.height
  const visited = new Uint8Array(width * height)
  const blobs: Blob[] = []

  const matches = (index: number): boolean => {
    const offset = index * 4
    return (
      Math.abs(png.data[offset] - tr) <= tolerance &&
      Math.abs(png.data[offset + 1] - tg) <= tolerance &&
      Math.abs(png.data[offset + 2] - tb) <= tolerance
    )
  }

  for (let start = 0; start < width * height; start += 1) {
    if (visited[start] || !matches(start)) continue

    const queue = [start]
    visited[start] = 1
    let area = 0
    let sumX = 0
    let sumY = 0

    while (queue.length > 0) {
      const index = queue.pop() as number
      const x = index % width
      const y = Math.floor(index / width)
      area += 1
      sumX += x
      sumY += y

      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ]

      for (const neighbour of neighbours) {
        if (neighbour >= 0 && !visited[neighbour] && matches(neighbour)) {
          visited[neighbour] = 1
          queue.push(neighbour)
        }
      }
    }

    if (area >= minArea) {
      blobs.push({ x: sumX / area, y: sumY / area, area })
    }
  }

  return blobs.sort((a, b) => a.y - b.y || a.x - b.x)
}

/** Capture la zone carte et décode le PNG pour analyse pixel. */
export async function screenshotPng(
  page: Page,
  selector: string,
): Promise<PNG> {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`Zone carte introuvable : ${selector}`)
  const buffer = await page.screenshot({
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.floor(box.width),
      height: Math.floor(box.height),
    },
  })
  return PNG.sync.read(buffer)
}
