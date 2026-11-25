import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import { PMTiles, Protocol } from 'pmtiles'
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  StyleSpecification,
} from 'maplibre-gl'
import type {
  FeatureCollection,
  LineString,
  Point as GeoJSONPoint,
  Polygon as GeoJSONPolygon,
} from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'

// MapLibre v6 : worker explicitement empaqueté par Vite.
setWorkerUrl(workerUrl)

// PMTiles : protocole enregistré une seule fois au chargement du module.
const PMTILES_URL = (import.meta.env.VITE_MAPNIFIQUE_PMTILES_URL || '').trim()
const RASTER_TILE_URL = (import.meta.env.VITE_MAPNIFIQUE_RASTER_TILE_URL ||
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png').trim()
const VECTOR_STYLE_URL = (import.meta.env.VITE_MAPNIFIQUE_STYLE_URL ||
  'https://tiles.openfreemap.org/styles/positron').trim()
const pmtilesProtocol = new Protocol({ metadata: true })

maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile)

if (PMTILES_URL) {
  pmtilesProtocol.add(new PMTiles(PMTILES_URL))
}

type MapPoint = { lat: number; lon: number }

type MapPlace = {
  id: string
  name: string
  lat: number
  lon: number
}

type Props = {
  center: MapPoint
  recenterRequest: number
  places: MapPlace[]
  selectedId: string | null
  onSelect: (id: string) => void
  fitPlaces?: boolean
  routeCoordinates: [number, number][]
  showRoute: boolean
  userPoint: MapPoint | null
  userHeading: number | null
}

type PlaceProperties = {
  id: string
  name: string
  selected: boolean
}

const RASTER_FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: [RASTER_TILE_URL],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm-raster',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-fade-duration': 0 },
    },
  ],
}

const VECTOR_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    'mapnifique-osm': {
      type: 'vector',
      url: `pmtiles://${PMTILES_URL}`,
      attribution: '&copy; OpenStreetMap contributors &copy; OpenMapTiles',
    },
  },
  layers: [
    {
      id: 'mn-background',
      type: 'background',
      paint: { 'background-color': '#F7F5EF' },
    },
    {
      id: 'mn-landcover',
      type: 'fill',
      source: 'mapnifique-osm',
      'source-layer': 'landcover',
      paint: {
        'fill-color': [
          'match', ['get', 'class'],
          'wood', '#DCE8D4',
          'grass', '#E8EEDD',
          'farmland', '#EFEAD9',
          'wetland', '#DDE9E3',
          'sand', '#F1E8D6',
          '#E8E9DF',
        ],
        'fill-opacity': 0.85,
      },
    },
    {
      id: 'mn-landuse',
      type: 'fill',
      source: 'mapnifique-osm',
      'source-layer': 'landuse',
      paint: {
        'fill-color': [
          'match', ['get', 'class'],
          'residential', '#F0EEE8',
          'commercial', '#F0E8DD',
          'industrial', '#ECE9E4',
          'retail', '#F3EBDD',
          'cemetery', '#DFE9DC',
          'school', '#E9EBDD',
          'university', '#E7EBDD',
          'hospital', '#F1E4E2',
          'stadium', '#E7E9E1',
          'playground', '#DDEBD7',
          '#E9EAE4',
        ],
        'fill-opacity': 0.65,
      },
    },
    {
      id: 'mn-water',
      type: 'fill',
      source: 'mapnifique-osm',
      'source-layer': 'water',
      paint: {
        'fill-color': '#C9DFE3',
        'fill-opacity': 1,
      },
    },
    {
      id: 'mn-park',
      type: 'fill',
      source: 'mapnifique-osm',
      'source-layer': 'park',
      paint: {
        'fill-color': '#D8E7D3',
        'fill-opacity': 0.85,
      },
    },
    {
      id: 'mn-waterway',
      type: 'line',
      source: 'mapnifique-osm',
      'source-layer': 'waterway',
      paint: {
        'line-color': '#B4D3DA',
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 2.5],
      },
    },
    {
      id: 'mn-buildings-3d',
      type: 'fill-extrusion',
      source: 'mapnifique-osm',
      'source-layer': 'building',
      minzoom: 14,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': [
          'coalesce', ['get', 'colour'], '#DED9CE',
        ],
        'fill-extrusion-height': [
          'coalesce', ['get', 'render_height'], 5,
        ],
        'fill-extrusion-base': [
          'coalesce', ['get', 'render_min_height'], 0,
        ],
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': true,
      },
    },
    {
      id: 'mn-road-casing',
      type: 'line',
      source: 'mapnifique-osm',
      'source-layer': 'transportation',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': '#FFFDF9',
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          5, 0.8,
          10, 2.2,
          14, 7,
        ],
      },
    },
    {
      id: 'mn-roads',
      type: 'line',
      source: 'mapnifique-osm',
      'source-layer': 'transportation',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': [
          'match', ['get', 'class'],
          'motorway', '#D6AE83',
          'trunk', '#E1C49A',
          'primary', '#EBD6AE',
          'secondary', '#FFFDF7',
          'tertiary', '#FFFEFA',
          'minor', '#FFFEFA',
          'service', '#F9F7F1',
          'path', '#C5C1B6',
          '#F6F4EF',
        ],
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          5, [
            'match', ['get', 'class'],
            'motorway', 1.1, 'trunk', 0.95,
            'primary', 0.75, 0.25,
          ],
          14, [
            'match', ['get', 'class'],
            'motorway', 6.5, 'trunk', 5.8,
            'primary', 5, 'secondary', 4.2,
            'tertiary', 3.5, 'minor', 2.8,
            'service', 1.6, 'path', 1, 0.8,
          ],
        ],
      },
    },
    {
      id: 'mn-place-labels',
      type: 'symbol',
      source: 'mapnifique-osm',
      'source-layer': 'place',
      filter: ['has', 'name'],
      layout: {
        'text-field': [
          'coalesce', ['get', 'name:fr'], ['get', 'name'],
        ],
        'text-font': ['Open Sans Semibold'],
        'text-size': [
          'match', ['get', 'class'],
          'city', 16,
          'town', 14,
          'village', 12,
          'suburb', 11,
          10,
        ],
        'text-max-width': 9,
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#34443B',
        'text-halo-color': '#F7F5EF',
        'text-halo-width': 1.5,
      },
    },
    {
      id: 'mn-road-labels',
      type: 'symbol',
      source: 'mapnifique-osm',
      'source-layer': 'transportation_name',
      minzoom: 13,
      filter: ['has', 'name'],
      layout: {
        'symbol-placement': 'line',
        'text-field': [
          'coalesce', ['get', 'name:fr'], ['get', 'name'],
        ],
        'text-font': ['Open Sans Regular'],
        'text-size': 10,
        'text-max-angle': 30,
      },
      paint: {
        'text-color': '#77766F',
        'text-halo-color': '#FFFDF8',
        'text-halo-width': 1.2,
      },
    },
    {
      id: 'mn-water-labels',
      type: 'symbol',
      source: 'mapnifique-osm',
      'source-layer': 'water_name',
      minzoom: 10,
      filter: ['has', 'name'],
      layout: {
        'text-field': [
          'coalesce', ['get', 'name:fr'], ['get', 'name'],
        ],
        'text-font': ['Open Sans Regular'],
        'text-size': 11,
      },
      paint: {
        'text-color': '#5D8994',
        'text-halo-color': '#E7F0EF',
        'text-halo-width': 1,
      },
    },
    {
      id: 'mn-poi-labels',
      type: 'symbol',
      source: 'mapnifique-osm',
      'source-layer': 'poi',
      minzoom: 16,
      filter: ['has', 'name'],
      layout: {
        'text-field': [
          'coalesce', ['get', 'name:fr'], ['get', 'name'],
        ],
        'text-font': ['Open Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 0.8],
        'text-anchor': 'top',
        'text-max-width': 9,
      },
      paint: {
        'text-color': '#586157',
        'text-halo-color': '#FFFDF8',
        'text-halo-width': 1.2,
      },
    },
    {
      id: 'mn-house-numbers',
      type: 'symbol',
      source: 'mapnifique-osm',
      'source-layer': 'housenumber',
      minzoom: 18,
      layout: {
        'text-field': ['get', 'housenumber'],
        'text-font': ['Open Sans Regular'],
        'text-size': 9,
      },
      paint: {
        'text-color': '#77736A',
        'text-halo-color': '#FFFDF8',
        'text-halo-width': 1,
      },
    },
  ],
}

const BASE_STYLE: StyleSpecification | string = PMTILES_URL
  ? VECTOR_STYLE
  : (VECTOR_STYLE_URL || RASTER_FALLBACK_STYLE)

function createPlacesData(
  places: MapPlace[],
  selectedId: string | null,
): FeatureCollection<GeoJSONPoint, PlaceProperties> {
  return {
    type: 'FeatureCollection',
    features: places.map((place) => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [place.lon, place.lat],
      },
      properties: {
        id: place.id,
        name: place.name,
        selected: place.id === selectedId,
      },
    })),
  }
}

function destinationPoint(
  center: MapPoint,
  distanceMeters: number,
  bearingDegrees: number,
): [number, number] {
  const radius = 6371008.8
  const angularDistance = distanceMeters / radius
  const bearing = bearingDegrees * Math.PI / 180
  const lat1 = center.lat * Math.PI / 180
  const lon1 = center.lon * Math.PI / 180

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  )

  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
  )

  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]
}

function createAccuracyData(
  point: MapPoint | null,
): FeatureCollection<GeoJSONPolygon> {
  if (!point) {
    return { type: 'FeatureCollection', features: [] }
  }

  const coordinates: [number, number][] = []

  for (let index = 0; index <= 64; index += 1) {
    coordinates.push(destinationPoint(point, 55, index * 360 / 64))
  }

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [coordinates],
      },
    }],
  }
}

function createRouteData(
  points: [number, number][],
  visible: boolean,
): FeatureCollection<LineString> {
  if (!visible || points.length < 2) {
    return { type: 'FeatureCollection', features: [] }
  }

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        // Les coordonnées reçues sont [latitude, longitude].
        // GeoJSON et MapLibre attendent [longitude, latitude].
        coordinates: points.map(([lat, lon]) => [lon, lat]),
      },
    }],
  }
}

function distanceMeters(a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180
  const lat1 = a[1] * radians
  const lat2 = b[1] * radians
  const deltaLat = (b[1] - a[1]) * radians
  const deltaLon = (b[0] - a[0]) * radians

  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(deltaLon / 2) ** 2

  return 6371008.8 * 2 * Math.atan2(
    Math.sqrt(value),
    Math.sqrt(1 - value),
  )
}

function clusterDiagonal(features: GeoJSON.Feature[]) {
  const coordinates = features.flatMap((feature) => {
    if (feature.geometry.type !== 'Point') return []
    return [feature.geometry.coordinates as [number, number]]
  })

  if (coordinates.length < 2) return 0

  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity

  for (const [lon, lat] of coordinates) {
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }

  return distanceMeters([west, south], [east, north])
}

export default function MapLibreView({
  center,
  recenterRequest,
  places,
  selectedId,
  onSelect,
  fitPlaces = false,
  routeCoordinates,
  showRoute,
  userPoint,
  userHeading,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const userMarkerRef = useRef<maplibregl.Marker | null>(null)
  const onSelectRef = useRef(onSelect)
  const [mapReady, setMapReady] = useState(false)

  const placesData = useMemo(
    () => createPlacesData(places, selectedId),
    [places, selectedId],
  )

  const accuracyData = useMemo(
    () => createAccuracyData(userPoint),
    [userPoint],
  )

  const routeData = useMemo(
    () => createRouteData(routeCoordinates, showRoute),
    [routeCoordinates, showRoute],
  )
  const userLatitude = userPoint?.lat ?? null
  const userLongitude = userPoint?.lon ?? null

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  // Initialisation unique du moteur cartographique.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const map = new maplibregl.Map({
      container,
      style: BASE_STYLE,
      center: [center.lon, center.lat],
      zoom: 13,
      minZoom: 2,
      maxZoom: 19,
    })

    mapRef.current = map

    map.addControl(
      new maplibregl.NavigationControl({
        showCompass: false,
        showZoom: true,
      }),
      'bottom-left',
    )

    map.once('load', () => {
      if (mapRef.current !== map) return

      map.addSource('places', {
        type: 'geojson',
        data: createPlacesData(places, selectedId),
        cluster: true,
        clusterRadius: 40,
        clusterMaxZoom: 16,
      })

      map.addLayer({
        id: 'place-clusters',
        type: 'circle',
        source: 'places',
        filter: ['has', 'point_count'],
        paint: {
          'circle-radius': 24,
          'circle-color': '#18392E',
          'circle-stroke-color': '#B99B68',
          'circle-stroke-width': 3,
        },
      })

      map.addLayer({
        id: 'place-cluster-count',
        type: 'symbol',
        source: 'places',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 13,
          'text-font': ['Open Sans Bold'],
        },
        paint: {
          'text-color': '#FFFDF8',
        },
      })

      map.addLayer({
        id: 'place-points',
        type: 'circle',
        source: 'places',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': [
            'case',
            ['boolean', ['get', 'selected'], false],
            14,
            11,
          ],
          'circle-color': [
            'case',
            ['boolean', ['get', 'selected'], false],
            '#18392E',
            '#2864E8',
          ],
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-width': 3,
        },
      })

      map.addSource('user-accuracy', {
        type: 'geojson',
        data: createAccuracyData(userPoint),
      })

      map.addLayer({
        id: 'user-accuracy-fill',
        type: 'fill',
        source: 'user-accuracy',
        paint: {
          'fill-color': '#60A5FA',
          'fill-opacity': 0.16,
        },
      })

      map.addLayer({
        id: 'user-accuracy-outline',
        type: 'line',
        source: 'user-accuracy',
        paint: {
          'line-color': '#2563EB',
          'line-opacity': 0.55,
          'line-width': 1,
        },
      })

      map.addSource('route', {
        type: 'geojson',
        data: createRouteData(routeCoordinates, showRoute),
      })

      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#FFFFFF',
          'line-width': 10,
          'line-opacity': 0.85,
        },
      })

      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#49664E',
          'line-width': 6,
          'line-opacity': 0.94,
        },
      })

      // Clic sur un groupe de commerces.
      map.on('click', 'place-clusters', (event: MapLayerMouseEvent) => {
        const feature = event.features?.[0]
        if (!feature || feature.geometry.type !== 'Point') return

        const clusterId = Number(feature.properties?.cluster_id)
        const count = Number(feature.properties?.point_count)
        const coordinates = feature.geometry.coordinates as [number, number]

        if (
          !Number.isFinite(clusterId) ||
          !Number.isFinite(count) ||
          count < 1
        ) return

        const source = map.getSource('places') as GeoJSONSource

        void (async () => {
          try {
            const leaves = await source.getClusterLeaves(
              clusterId,
              Math.max(1, count),
              0,
            )

            if (leaves.length > 0 && clusterDiagonal(leaves) < 12) {
              const first = leaves[0].properties as
                Record<string, unknown> | null
              const id = first?.id

              if (typeof id === 'string') {
                onSelectRef.current(id)
                return
              }
            }

            const zoom = await source.getClusterExpansionZoom(clusterId)

            if (!Number.isFinite(zoom)) return

            map.easeTo({
              center: coordinates,
              zoom,
              duration: 550,
            })
          } catch (error) {
            console.error(
              'MapNifique : impossible de développer ce groupe de commerces.',
              error,
            )
          }
        })()
      })

      // Clic sur un commerce individuel.
      map.on('click', 'place-points', (event: MapLayerMouseEvent) => {
        const id = event.features?.[0]?.properties?.id
        if (typeof id === 'string') onSelectRef.current(id)
      })

      for (const layer of ['place-clusters', 'place-points']) {
        map.on('mouseenter', layer, () => {
          map.getCanvas().style.cursor = 'pointer'
        })

        map.on('mouseleave', layer, () => {
          map.getCanvas().style.cursor = ''
        })
      }

      setMapReady(true)
    })

    return () => {
      userMarkerRef.current?.remove()
      userMarkerRef.current = null
      map.remove()
      mapRef.current = null
      setMapReady(false)
    }
    // Les mises à jour des données sont gérées par des effets séparés.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redimensionnement du canvas lorsque le panneau latéral change.
  useEffect(() => {
    const container = containerRef.current
    const map = mapRef.current
    if (!container || !map || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => map.resize())
    observer.observe(container)

    return () => observer.disconnect()
  }, [mapReady])

  // Actualisation des commerces et du regroupement.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return

    const source = mapRef.current.getSource('places') as
      GeoJSONSource | undefined

    source?.setData(placesData)
  }, [mapReady, placesData])

  // Actualisation de la zone de précision GPS.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return

    const source = mapRef.current.getSource('user-accuracy') as
      GeoJSONSource | undefined

    source?.setData(accuracyData)
  }, [mapReady, accuracyData])

  // Actualisation et cadrage de l'itinéraire.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return

    const map = mapRef.current
    const source = map.getSource('route') as GeoJSONSource | undefined
    source?.setData(routeData)

    if (!showRoute || routeCoordinates.length < 2) return

    const bounds = new maplibregl.LngLatBounds()

    for (const [lat, lon] of routeCoordinates) {
      bounds.extend([lon, lat])
    }

    const sw = bounds.getSouthWest()
    const ne = bounds.getNorthEast()
    const diagonal = distanceMeters(
      [sw.lng, sw.lat],
      [ne.lng, ne.lat],
    )

    if (diagonal <= 180) {
      map.flyTo({
        center: bounds.getCenter(),
        zoom: 19,
        duration: 850,
      })
      return
    }

    const maxZoom =
      diagonal <= 450 ? 18.5 :
      diagonal <= 1200 ? 17.5 :
      diagonal <= 3500 ? 16.5 :
      15.5

    map.fitBounds(bounds, {
      padding: 90,
      maxZoom,
      duration: 700,
    })
  }, [mapReady, routeData, routeCoordinates, showRoute])

  // Recentrage demandé par l'application.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || recenterRequest === 0) return

    map.flyTo({
      center: [center.lon, center.lat],
      zoom: Math.max(map.getZoom(), 14),
      duration: 700,
    })
  }, [mapReady, center.lat, center.lon, recenterRequest])

  // Cadrage des résultats d'une recherche.
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map || !fitPlaces || places.length === 0) return

    if (places.length === 1) {
      map.flyTo({
        center: [places[0].lon, places[0].lat],
        zoom: 15,
        duration: 600,
      })
      return
    }

    const bounds = new maplibregl.LngLatBounds()

    for (const place of places) {
      bounds.extend([place.lon, place.lat])
    }

    map.fitBounds(bounds, {
      padding: 55,
      maxZoom: 15,
      duration: 650,
    })
  }, [mapReady, fitPlaces, places])

  // Marqueur GPS HTML conservant le design existant.
  useEffect(() => {
    const map = mapRef.current

    userMarkerRef.current?.remove()
    userMarkerRef.current = null

    if (
      !map ||
      !mapReady ||
      userLatitude === null ||
      userLongitude === null
    ) return

    const element = document.createElement('div')
    element.className = 'user-marker-shell'
    element.setAttribute('aria-label', 'Votre position')
    element.innerHTML = `
      <div class="user-marker-wrap" style="--user-heading:0deg">
        <span class="user-marker-pulse"></span>
        <span class="user-marker-direction"></span>
        <div class="user-marker">
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="8" r="5" />
            <path d="M13 17 Q20 13 27 17 L29 27 L25 27 L24 38 L19 38 L18 27 L15 38 L10 38 L13 23 L10 27 L7 25 Z" />
          </svg>
        </div>
      </div>
    `

    const marker = new maplibregl.Marker({
      element,
      anchor: 'center',
    })
      .setLngLat([userLongitude, userLatitude])
      .addTo(map)

    userMarkerRef.current = marker

    return () => {
      marker.remove()
      if (userMarkerRef.current === marker) {
        userMarkerRef.current = null
      }
    }
  }, [mapReady, userLatitude, userLongitude])

  // Mise à jour de l'orientation sans recréer le marqueur.
  useEffect(() => {
    const marker = userMarkerRef.current
    const wrap = marker?.getElement().querySelector<HTMLElement>(
      '.user-marker-wrap',
    )

    wrap?.style.setProperty('--user-heading', `${userHeading ?? 0}deg`)
  }, [userHeading, mapReady, userLatitude, userLongitude])

  return (
    <div
      ref={containerRef}
      className="maplibre-map"
      role="application"
      aria-label="Carte des commerces et bons plans"
      style={{
        width: '100%',
        height: '100%',
        minHeight: 420,
        background: '#EAE7DE',
      }}
    />
  )
}
