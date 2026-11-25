import { expect, test, type Page } from '@playwright/test'
import {
  FAR_PLACES,
  NEW_PLACES,
  findColorBlobs,
  hideMapOverlays,
  installMockRoutes,
  screenshotPng,
} from './helpers'

// Les pastilles MapLibre sont dessinées sur un canvas WebGL : on ne peut pas
// les compter dans le DOM. La couche `place-points` peint les points non
// sélectionnés en #2864E8 ; on compte donc les zones bleues réellement rendues.
const POINT_COLOR = '#2864E8'
const POINT_OR_CLUSTER_COLOR = '#18392E'
const CLUSTER_MIN_AREA = 1200

const SEARCH_INPUT_LABEL = 'Rechercher un commerce ou une catégorie'

async function launchSearch(page: Page, query: string): Promise<void> {
  await page.getByRole('textbox', { name: SEARCH_INPUT_LABEL }).fill(query)
  await page.locator('.search-submit').click()
}

async function expectCards(page: Page, count: number): Promise<void> {
  await expect(page.locator('.place-list .place-card')).toHaveCount(count, {
    timeout: 15000,
  })
}

async function maplibreBlobs(page: Page): Promise<{
  points: number
  clusters: number
  blueCentroids: { x: number; y: number }[]
  darkCentroids: { x: number; y: number; area: number }[]
}> {
  await page.waitForTimeout(1400)
  const png = await screenshotPng(page, '.maplibre-map')
  // Analyse de la zone carte utile : on exclut la barre de catégories (~50px
  // en haut) et l'attribution (~30px en bas) qui utilisent les couleurs de la
  // marque, sans toucher aux pastilles que le cadrage place à >= 90px du bord.
  const top = 60
  const bottom = png.height - 45
  const band = {
    data: png.data.subarray(top * png.width * 4, bottom * png.width * 4),
    width: png.width,
    height: bottom - top,
  } as PNG
  const blue = findColorBlobs(band, POINT_COLOR)
  const dark = findColorBlobs(band, POINT_OR_CLUSTER_COLOR)
  const clusters = dark.filter((blob) => blob.area >= CLUSTER_MIN_AREA)
  return {
    points: blue.length,
    clusters: clusters.length,
    blueCentroids: blue.map((blob) => ({
      x: blob.x,
      y: blob.y + top,
    })),
    darkCentroids: clusters.map((blob) => ({
      x: blob.x,
      y: blob.y + top,
      area: blob.area,
    })),
  }
}

/** Assertion avec rechute : compte exact des pastilles dans un contexte propre. */
async function expectMaplibreBlobs(
  page: Page,
  expected: { points?: number; clusters?: number },
): Promise<void> {
  await expect(async () => {
    const blobs = await maplibreBlobs(page)
    if (expected.points !== undefined) {
      expect(blobs.points).toBe(expected.points)
    }
    if (expected.clusters !== undefined) {
      expect(blobs.clusters).toBe(expected.clusters)
    }
  }).toPass({ timeout: 20000 })
}

/**
 * Recule la carte de `clicks` niveaux de zoom pour rendre le comptage des
 * pastilles indépendant de la course entre recentrage et cadrage de recherche :
 * à zoom réduit, tous les lieux de la fixture tiennent dans le viewport.
 */
async function maplibreZoomOut(page: Page, clicks: number): Promise<void> {
  const button = page.getByRole('button', { name: 'Zoom out' })
  for (let index = 0; index < clicks; index += 1) {
    // dispatchEvent : les contrôles flottants de l'application recouvrent le
    // bouton natif ; un clic synthétique atteint directement le handler.
    await button.dispatchEvent('click')
    await page.waitForTimeout(800)
  }
  await page.waitForTimeout(600)
}

async function engineName(): Promise<'maplibre' | 'leaflet'> {
  return test.info().project.name === 'leaflet' ? 'leaflet' : 'maplibre'
}

test.beforeEach(async ({ page }) => {
  await installMockRoutes(page)
  await page.goto('/')
  await hideMapOverlays(page)
  await launchSearch(page, 'test')
  await expectCards(page, FAR_PLACES.length)
  // Laisse finir les animations de cadrage avant les comptages.
  await page.waitForTimeout(1500)
})

test('cinq commerces sont rendus sur la carte', async ({ page }) => {
  if ((await engineName()) === 'maplibre') {
    // Un recul de zoom éloigne les pastilles des zones d'interface tout en
    // restant au-dessus du seuil de regroupement.
    await maplibreZoomOut(page, 1)
    await expectMaplibreBlobs(page, { points: 5, clusters: 0 })
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(5)
    await expect(page.locator('.map-cluster')).toHaveCount(0)
  }
})

test('sélectionner un commerce conserve tous les marqueurs', async ({
  page,
}) => {
  if ((await engineName()) === 'maplibre') {
    await maplibreZoomOut(page, 1)
  }

  const thirdCard = page.locator('.place-list .place-card').nth(2)
  await thirdCard.locator('.place-card-main').click()

  await expect(page.locator('.detail-panel h2')).toHaveText(FAR_PLACES[2].name)
  await expect(page.locator('.place-card.is-selected')).toHaveCount(1)
  await expectCards(page, FAR_PLACES.length)

  if ((await engineName()) === 'maplibre') {
    // La fiche recouvre la droite de la carte : plusieurs pastilles peuvent
    // être masquées, mais au moins deux restent visibles et, surtout, une
    // pastille visible reste cliquable pendant la sélection (la source
    // d'avant correctif ne contenait que le lieu sélectionné).
    await expect(async () => {
      const blobs = await maplibreBlobs(page)
      expect(blobs.points).toBeGreaterThanOrEqual(2)
    }).toPass({ timeout: 20000 })

    const mapBox = await page.locator('.maplibre-map').boundingBox()
    const other = (await maplibreBlobs(page)).blueCentroids[0]
    await page.mouse.click(mapBox!.x + other.x, mapBox!.y + other.y)
    await page.waitForTimeout(1200)
    const switchedName = await page.locator('.detail-panel h2').textContent()
    expect(
      FAR_PLACES.map((place) => place.name),
      'une autre pastille reste sélectionnable pendant la sélection',
    ).toContain(switchedName)
    expect(switchedName).not.toBe(FAR_PLACES[2].name)
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(5)
    await expect(page.locator('.map-marker.is-selected')).toHaveCount(1)
  }

  // Changer de sélection depuis la liste.
  const fifthCard = page.locator('.place-list .place-card').nth(4)
  await fifthCard.locator('.place-card-main').click()
  await expect(page.locator('.detail-panel h2')).toHaveText(FAR_PLACES[4].name)
  await expect(page.locator('.place-card.is-selected')).toHaveCount(1)
  await expect(page.locator('.place-card.is-selected strong')).toHaveText(
    FAR_PLACES[4].name,
  )

  // Fermer la fiche : aucun marqueur ne doit disparaître.
  await page.locator('.detail-close').click()
  await expect(page.locator('.detail-panel')).toHaveCount(0)

  if ((await engineName()) === 'maplibre') {
    await expectMaplibreBlobs(page, { points: 5, clusters: 0 })
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(5)
    await expect(page.locator('.map-cluster')).toHaveCount(0)
  }
})

test('un marqueur carte reste sélectionnable après une autre sélection', async ({
  page,
}) => {
  const allNames = FAR_PLACES.map((place) => place.name)

  if ((await engineName()) === 'maplibre') {
    await maplibreZoomOut(page, 1)
    await expectMaplibreBlobs(page, { points: 5, clusters: 0 })
    const blobs = await maplibreBlobs(page)

    const mapBox = await page.locator('.maplibre-map').boundingBox()
    expect(mapBox).not.toBeNull()

    // Sélection réelle par clic sur le canvas WebGL : la pastille cliquée est
    // identifiée par le nom affiché dans la fiche, pas par sa position.
    const first = blobs.blueCentroids[0]
    await page.mouse.click(mapBox!.x + first.x, mapBox!.y + first.y)
    const firstName = await page.locator('.detail-panel h2').textContent()
    expect(
      allNames,
      'la fiche ouverte correspond à un commerce affiché',
    ).toContain(firstName)
    await expect(page.locator('.place-card.is-selected')).toHaveCount(1)

    // Une autre pastille reste cliquable pendant la sélection : la fiche qui
    // recouvre la droite de la carte peut en masquer, pas toutes.
    await page.waitForTimeout(1200)
    const after = await maplibreBlobs(page)
    expect(
      after.blueCentroids.length,
      'plusieurs pastilles bleues restent sélectionnables',
    ).toBeGreaterThanOrEqual(2)

    const next = after.blueCentroids[0]
    await page.mouse.click(mapBox!.x + next.x, mapBox!.y + next.y)
    const secondName = await page.locator('.detail-panel h2').textContent()
    expect(secondName).not.toBe(firstName)
    expect(allNames).toContain(secondName)
    await expect(page.locator('.place-card.is-selected strong')).toHaveText(
      secondName ?? '',
    )
  } else {
    // L'ordre DOM des marqueurs suit les groupes de grille, pas les données :
    // on identifie chaque pastille par la fiche ouverte, comme sur MapLibre.
    await page.locator('.map-marker').nth(0).click()
    const firstName = await page.locator('.detail-panel h2').textContent()
    expect(allNames, 'la fiche ouverte correspond à un commerce affiché')
      .toContain(firstName)
    await expect(page.locator('.map-marker.is-selected')).toHaveCount(1)
    await expect(page.locator('.map-marker')).toHaveCount(5)

    await page.locator('.map-marker').nth(1).click()
    const secondName = await page.locator('.detail-panel h2').textContent()
    expect(secondName).not.toBe(firstName)
    expect(allNames).toContain(secondName)
    await expect(page.locator('.map-marker')).toHaveCount(5)
  }
})

test('les commerces rapprochés sont regroupés puis individuels après zoom', async ({
  page,
}) => {
  await launchSearch(page, 'proches')
  await expectCards(page, 5)

  if ((await engineName()) === 'maplibre') {
    // Descendre sous clusterMaxZoom (16) : les cinq lieux fusionnent.
    await maplibreZoomOut(page, 4)
    const clustered = await maplibreBlobs(page)
    expect(
      clustered.clusters,
      'au moins un groupe de commerces dessiné',
    ).toBeGreaterThanOrEqual(1)
    expect(clustered.points, 'plus aucune pastille individuelle').toBe(0)

    // Clic sur le groupe : expansion du zoom, puis zoom complémentaire pour
    // garantir des pastilles individuelles (l'expansion peut être partielle).
    const mapBox = await page.locator('.maplibre-map').boundingBox()
    const cluster = clustered.darkCentroids[0]
    await page.mouse.click(mapBox!.x + cluster.x, mapBox!.y + cluster.y)
    await page.waitForTimeout(1800)
    const zoomIn = page.getByRole('button', { name: 'Zoom in' })
    for (let index = 0; index < 3; index += 1) {
      await zoomIn.dispatchEvent('click')
      await page.waitForTimeout(700)
    }
    await expectMaplibreBlobs(page, { points: 5, clusters: 0 })
  } else {
    // À zoom 15 (cadrage automatique), les lieux proches forment un ou deux
    // groupes : cohérence clusters + marqueurs == nombre de commerces.
    await expect(async () => {
      const clusterLabels = await page
        .locator('.map-cluster span')
        .allTextContents()
      const markerCount = await page.locator('.map-marker').count()
      const clustered = clusterLabels.reduce(
        (total, label) => total + Number(label || 0),
        0,
      )
      expect(clusterLabels.length).toBeGreaterThanOrEqual(1)
      expect(markerCount + clustered).toBe(5)
      expect(markerCount, 'des commerces restent individuels').toBeLessThan(5)
    }).toPass({ timeout: 15000 })

    // Zoomer suffit à individualiser les commerces (zoom >= 17).
    for (let index = 0; index < 8; index += 1) {
      await page.locator('.leaflet-control-zoom-in').click()
      await page.waitForTimeout(400)
    }
    await expect(page.locator('.map-marker')).toHaveCount(5, {
      timeout: 15000,
    })
    await expect(page.locator('.map-cluster')).toHaveCount(0)
  }
})

test('le filtre par catégorie met la carte en accord avec la liste', async ({
  page,
}) => {
  await page.locator('.map-category-chip', { hasText: 'Supermarché' }).click()
  await expectCards(page, 1)

  if ((await engineName()) === 'maplibre') {
    await expectMaplibreBlobs(page, { points: 1, clusters: 0 })
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(1)
    await expect(page.locator('.map-cluster')).toHaveCount(0)
  }
  await expect(page.locator('.place-card.is-selected')).toHaveCount(0)
})

test('une recherche sans résultat vide la carte', async ({ page }) => {
  await launchSearch(page, 'aucun')
  await expectCards(page, 0)

  if ((await engineName()) === 'maplibre') {
    await expectMaplibreBlobs(page, { points: 0, clusters: 0 })
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(0)
    await expect(page.locator('.map-cluster')).toHaveCount(0)
  }
})

test('une nouvelle recherche remplace exactement les commerces affichés', async ({
  page,
}) => {
  if ((await engineName()) === 'maplibre') {
    await maplibreZoomOut(page, 1)
    // État initial : le comptage exact est déjà garanti par le test dédié ;
    // ici on tolère une pastille masquée par une superposition résiduelle.
    await expect(async () => {
      const blobs = await maplibreBlobs(page)
      expect(blobs.points).toBeGreaterThanOrEqual(4)
    }).toPass({ timeout: 20000 })
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(5)
  }

  await launchSearch(page, 'nouvelle')
  await expectCards(page, 3)

  if ((await engineName()) === 'maplibre') {
    await maplibreZoomOut(page, 1)
    await expectMaplibreBlobs(page, { points: 3, clusters: 0 })
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(3)
  }

  const newNames = NEW_PLACES.map((place) => place.name)
  for (const name of newNames) {
    await expect(page.locator('.place-list').getByText(name)).toHaveCount(1)
  }
  // Les anciens commerces ne sont plus listés ni rendus.
  for (const place of FAR_PLACES) {
    await expect(page.locator('.place-list').getByText(place.name)).toHaveCount(
      0,
    )
  }

  // Identité : cliquer une pastille carte ouvre la fiche d'un des trois
  // nouveaux commerces, jamais un reste de la recherche précédente.
  if ((await engineName()) === 'maplibre') {
    const blobs = await maplibreBlobs(page)
    const mapBox = await page.locator('.maplibre-map').boundingBox()
    const target = blobs.blueCentroids[0]
    await page.mouse.click(mapBox!.x + target.x, mapBox!.y + target.y)
  } else {
    await page.locator('.map-marker').nth(0).click()
  }
  await expect(page.locator('.detail-panel h2')).toHaveText(
    new RegExp(newNames.join('|')),
  )
})

test('un commerce unique reste sélectionnable et rendu', async ({ page }) => {
  await page.locator('.map-category-chip', { hasText: 'Pharmacie' }).click()
  await expectCards(page, 1)

  if ((await engineName()) === 'maplibre') {
    await expectMaplibreBlobs(page, { points: 1, clusters: 0 })
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(1)
  }

  await page.locator('.place-card-main').click()
  await expect(page.locator('.detail-panel h2')).toHaveText(FAR_PLACES[1].name)
  await page.locator('.detail-close').click()
  await expect(page.locator('.detail-panel')).toHaveCount(0)

  if ((await engineName()) === 'maplibre') {
    await expectMaplibreBlobs(page, { points: 1, clusters: 0 })
  } else {
    await expect(page.locator('.map-marker')).toHaveCount(1)
  }
})

// Garde-fou : les fixtures de test ne doivent jamais fuiter côté production.
test('les fixtures E2E restent confinées aux interceptions réseau', async ({
  page,
}, testInfo) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('e2e-')) requests.push(request.url())
  })
  await page.reload()
  await hideMapOverlays(page)
  await launchSearch(page, 'test')
  await expectCards(page, 5)
  expect(
    requests,
    'aucune requête ne transporte un identifiant de fixture',
  ).toEqual([])
  expect(testInfo.config.projects.length).toBeGreaterThanOrEqual(2)
})
