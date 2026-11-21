import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
const MapLibreView = lazy(() => import('./components/map/MapLibreView'))
import {
  MapContainer,
  Marker,
  TileLayer,
  Circle,
  Polyline,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import {
  AlertCircle,
  ArrowUpRight,
  BadgePercent,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Compass,
  ExternalLink,
  Globe2,
  Heart,
  LocateFixed,
  Navigation,
  Phone,
  RefreshCw,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Store,
  Tag,
  X,
} from 'lucide-react'
import { formatCatalogPrice } from './utils/catalog-price.js'
import 'leaflet/dist/leaflet.css'
import './App.css'
import './brand.css'

type Point = { lat: number; lon: number }
type SearchMode = 'smart' | 'nearby' | 'global'

type Place = {
  id: string
  name: string
  brand: string
  brandKey: string
  category: string
  lat: number
  lon: number
  address: string
  phone: string
  website: string
  openingHours: string
  image: string
  distance: number | null
}

type TravelMode = 'auto' | 'pedestrian' | 'bicycle' | 'multimodal'

type RouteStep = {
  instruction: string
  distanceKm: number
  durationSeconds: number
  type: number
}

type RouteResult = {
  distanceKm: number
  durationSeconds: number
  shape: string
  steps: RouteStep[]
  source?: string
}

type RouteState = {
  key: string
  result?: RouteResult
  error?: string
}

type CatalogItem = {
  externalId?: string
  title: string
  brand?: string
  price?: number | null
  currency?: string
  category?: string
  imageUrl?: string | null
  productUrl?: string | null
  description?: string
}

type Offer = {
  catalogItems?: CatalogItem[]
  id?: string
  placeId?: string | number
  storeName?: string
  storeBrandKey?: string
  storeLat?: number
  storeLon?: number
  title?: string
  description?: string
  discount_label?: string
  discountLabel?: string
  promo_code?: string
  promoCode?: string
  landing_url?: string
  landingUrl?: string
  source_url?: string
  sourceUrl?: string
  source_name?: string
  sourceName?: string
  valid_from?: string
  validFrom?: string
  valid_until?: string
  validUntil?: string
  verifiedAt?: string
  terms?: string
  offerType?: string
  scope?: string
  status?: string
}

type BrandOfferEntry = [brandKey: string, brandOffers: Offer[], storeOffers: Offer[]]

type OffersPayload = {
  storeOffers: Offer[]
  brandOffers: Offer[]
  onlineOffers: Offer[]
  cashbackOffers: Offer[]
}

const API_BASE = (import.meta.env.VITE_MAPNIFIQUE_API_URL || '').replace(/\/$/, '')
const USE_MAPLIBRE = String(import.meta.env.VITE_MAPNIFIQUE_MAP_ENGINE || 'maplibre').trim().toLowerCase() !== 'leaflet'
const RASTER_TILE_URL = (import.meta.env.VITE_MAPNIFIQUE_RASTER_TILE_URL ||
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png').trim()

const DEFAULT_CENTER: Point = { lat: 48.8566, lon: 2.3522 }
const DEFAULT_RADIUS = 3000

const EMPTY_OFFERS: OffersPayload = {
  storeOffers: [],
  brandOffers: [],
  onlineOffers: [],
  cashbackOffers: [],
}

const categories = [
  'Tout',
  'Beauté',
  'Supermarché',
  'Mode',
  'Sport',
  'Restauration',
  'Pharmacie',
  'Autres',
]

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

function asNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function slug(value: string): string {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function formatAddress(value: unknown): string {
  if (typeof value === 'string') return value.trim()

  const address = asRecord(value)
  const streetAddress = asText(
    address.street_address || address['addr:street_address'],
  )
  const houseNumber = asText(
    address.house_number || address['addr:housenumber'],
  )
  const streetName = asText(
    address.road || address.street || address['addr:street'],
  )
  const street = streetAddress || [houseNumber, streetName]
    .filter(Boolean)
    .join(' ')

  const parts = [
    street,
    asText(address.postcode || address['addr:postcode']),
    asText(
      address.city || address.town || address.village || address['addr:city'],
    ),
  ].filter(Boolean)

  return parts.join(', ') || 'Adresse non renseignée'
}

function extractPlaceRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.map(asRecord)

  const data = asRecord(payload)
  const candidates = [
    data.places,
    data.results,
    data.items,
    data.data,
  ]

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.map(asRecord)

    const nested = asRecord(candidate)
    for (const key of ['places', 'results', 'items']) {
      if (Array.isArray(nested[key])) {
        return (nested[key] as unknown[]).map(asRecord)
      }
    }
  }

  return []
}

function normalizePlace(
  raw: Record<string, unknown>,
  index: number,
  origin: Point | null,
): Place | null {
  const properties = asRecord(raw.properties)
  const location = asRecord(raw.location)
  const geometry = asRecord(raw.geometry)
  const coordinates = Array.isArray(geometry.coordinates)
    ? geometry.coordinates
    : Array.isArray(raw.coordinates)
      ? raw.coordinates
      : []

  const lat =
    asNumber(raw.lat ?? raw.latitude ?? location.lat) ??
    asNumber(coordinates[1])
  const lon =
    asNumber(raw.lon ?? raw.lng ?? raw.longitude ?? location.lon ?? location.lng) ??
    asNumber(coordinates[0])

  if (lat === null || lon === null) return null

  const name =
    asText(raw.name || properties.name || raw.brand) ||
    'Commerce sans nom'
  const brand =
    asText(raw.brand || properties.brand || raw.brand_name) || name
  const brandKey =
    asText(raw.brand_key || raw.brandKey || properties.brand_key) || slug(brand)
  const category =
    asText(raw.category || properties.category || raw.type) || 'Commerce'
  const id =
    asText(raw.id || raw.place_id || raw.external_id || raw.osm_id) ||
    `${slug(name)}-${index}`

  const addressValue = raw.address ?? properties.address
  const formattedAddress = formatAddress(addressValue)
  const address = formattedAddress !== 'Adresse non renseignée'
    ? formattedAddress
    : formatAddress(raw)
  const phone = asText(raw.phone || properties.phone)
  const website = asText(
    raw.website || raw.url || properties.website || properties.url,
  )
  const hours = raw.opening_hours || raw.openingHours || properties.opening_hours
  const openingHours =
    typeof hours === 'string'
      ? hours
      : hours && typeof hours === 'object'
        ? JSON.stringify(hours)
        : ''

  const image = asText(
    raw.imageUrl || raw.image_url || raw.image || properties.image,
  )

  return {
    id,
    name,
    brand,
    brandKey,
    category,
    lat,
    lon,
    address,
    phone,
    website,
    openingHours,
    image,
    distance: origin
      ? distanceMeters(origin, { lat, lon })
      : raw.distance_m === null || raw.distance_m === undefined
        ? null
        : asNumber(raw.distance_m),
  }
}

function distanceMeters(a: Point, b: Point): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180
  const earthRadius = 6371000
  const dLat = radians(b.lat - a.lat)
  const dLon = radians(b.lon - a.lon)
  const lat1 = radians(a.lat)
  const lat2 = radians(b.lat)

  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2

  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
}

function formatDistance(distance: number | null): string {
  if (distance === null) return ''
  if (distance < 1000) return `${Math.round(distance)} m`
  return `${(distance / 1000).toFixed(1).replace('.', ',')} km`
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

function rowsFromOffers(value: unknown): Offer[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Offer =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : []
}

function formatOfferValidity(validFrom?: string, validUntil?: string): string {
  const format = (value?: string) => {
    if (!value) return ''
    const date = new Date(`${value.slice(0, 10)}T12:00:00`)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }

  const start = format(validFrom)
  const end = format(validUntil)

  if (start && end) return `Du ${start} au ${end}`
  if (end) return `Jusqu'au ${end}`
  if (start) return `À partir du ${start}`
  return ''
}

function CatalogItemList({
  items,
  limit,
}: {
  items?: CatalogItem[]
  limit?: number
}) {
  if (!items?.length) return null

  const visibleItems = typeof limit === 'number'
    ? items.slice(0, limit)
    : items

  return (
    <div className="catalog-items">
      <div className="catalog-items-heading">
        <strong>Articles du catalogue</strong>
        <span>{items.length} références</span>
      </div>
      <div className="catalog-items-grid">
        {visibleItems.map((item, index) => {
          const imageUrl = safeUrl(item.imageUrl || '')
          const productUrl = safeUrl(item.productUrl || '')
          const price = formatCatalogPrice(item.price, item.currency)

          return (
            <article
              className="catalog-item-card"
              key={item.externalId || `${item.title}-${index}`}
            >
              <div className="catalog-item-image-wrap">
                {imageUrl.startsWith('https://') ? (
                  <img
                    className="catalog-item-image"
                    src={imageUrl}
                    alt={item.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <ShoppingBag size={23} />
                )}
              </div>
              <div className="catalog-item-copy">
                <strong className="catalog-item-name">{item.title}</strong>
                {item.brand && (
                  <span className="catalog-item-brand">{item.brand}</span>
                )}
                {item.category && (
                  <span className="catalog-item-category">{item.category}</span>
                )}
                <div className="catalog-item-bottom">
                  {price && (
                    <span className="catalog-item-price">
                      <b>{price.text}</b>
                      <small>{price.currencyKnown ? 'Prix catalogue' : 'Devise non confirmée'}</small>
                    </span>
                  )}
                  {productUrl && (
                    <a href={productUrl} target="_blank" rel="noreferrer">
                      Fiche produit <ArrowUpRight size={12} />
                    </a>
                  )}
                </div>
              </div>
            </article>
          )
        })}
      </div>
      {typeof limit === 'number' && items.length > visibleItems.length && (
        <p className="catalog-items-more">
          + {items.length - visibleItems.length} autres articles dans le catalogue complet.
        </p>
      )}
    </div>
  )
}

function categoryMatches(place: Place, category: string): boolean {
  if (category === 'Tout') return true

  const text = normalizeText(`${place.category} ${place.name} ${place.brand}`)
  const terms: Record<string, string[]> = {
    Beauté: ['beaute', 'cosmetique', 'parfum', 'coiffure', 'sephora', 'makeup'],
    Supermarché: [
      'supermarche',
      'marche',
      'aliment',
      'epicerie',
      'grocery',
      'franprix',
      'lidl',
      'carrefour',
      'monoprix',
    ],
    Mode: ['mode', 'vetement', 'chaussure', 'fashion', 'habillement'],
    Sport: ['sport', 'sports', 'equipement sportif', 'materiel sportif', 'magasin de sport'],
    Restauration: [
      'restauration',
      'restaurant',
      'cafe',
      'fast food',
      'boulangerie',
      'pizza',
      'food',
    ],
    Pharmacie: ['pharmacie', 'parapharmacie', 'medical', 'sante'],
    Autres: [],
  }

  if (category === 'Autres') {
    return !Object.entries(terms)
      .filter(([key]) => key !== 'Autres')
      .some(([, values]) => values.some((term) => text.includes(term)))
  }

  return (terms[category] || []).some((term) => text.includes(term))
}


function decodeValhallaShape(encoded: string, precision = 6): [number, number][] {
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const factor = 10 ** precision;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;

    do {
      if (index >= encoded.length) return coordinates;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0;
    shift = 0;

    do {
      if (index >= encoded.length) return coordinates;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / factor, lon / factor]);
  }

  return coordinates;
}

function MapFitPlaces({ places }: { places: Place[] }) {
  const map = useMap();

  useEffect(() => {
    if (!places.length) return;
    const points = places.map((place) => L.latLng(place.lat, place.lon));

    if (points.length === 1) {
      map.setView(points[0], 15, { animate: true });
    } else {
      map.fitBounds(L.latLngBounds(points), {
        padding: [55, 55],
        maxZoom: 15,
        animate: true,
      });
    }
  }, [map, places]);

  return null;
}

function formatRouteDistance(distanceKm: number): string {
  const meters = Math.max(0, Math.round(distanceKm * 1000))

  if (meters < 1000) return `${meters} m`
  return `${distanceKm.toFixed(1).replace('.', ',')} km`
}

function formatRouteDuration(durationSeconds: number): string {
  const minutes = Math.max(0, Math.round(durationSeconds / 60))

  if (durationSeconds < 60) return 'Moins d’1 min'
  if (minutes < 60) return `${minutes} min`

  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60

  return remaining > 0
    ? `${hours} h ${remaining} min`
    : `${hours} h`
}

function MapFitRoute({ points }: { points: [number, number][] }) {
  const map = useMap()

  useEffect(() => {
    if (points.length < 2) return

    const bounds = L.latLngBounds(points)
    const diagonalMeters = bounds
      .getSouthWest()
      .distanceTo(bounds.getNorthEast())

    // À proximité immédiate : vue au niveau de la rue.
    if (diagonalMeters <= 180) {
      map.flyTo(bounds.getCenter(), 19, {
        duration: 0.85,
      })
      return
    }

    const maxZoom =
      diagonalMeters <= 450 ? 18.5 :
      diagonalMeters <= 1200 ? 17.5 :
      diagonalMeters <= 3500 ? 16.5 :
      15.5

    map.fitBounds(bounds, {
      padding: [90, 90],
      maxZoom,
      animate: true,
    })
  }, [map, points])

  return null
}

// MAPNIFIQUE — GPS INDEPENDENT FROM MAP EXPLORATION V1
function MapRecenter({
  point,
  requestId,
}: {
  point: Point
  requestId: number
}) {
  const map = useMap()

  useEffect(() => {
    if (requestId === 0) return

    map.flyTo([point.lat, point.lon], Math.max(map.getZoom(), 14), {
      duration: 0.7,
    })
  }, [map, point.lat, point.lon, requestId])

  return null
}

const normalMarker = L.divIcon({
  className: 'map-marker-shell',
  html: '<div class="map-marker"><span></span></div>',
  iconSize: [30, 38],
  iconAnchor: [15, 35],
})

const selectedMarker = L.divIcon({
  className: 'map-marker-shell',
  html: '<div class="map-marker is-selected"><span></span></div>',
  iconSize: [36, 44],
  iconAnchor: [18, 41],
})

const PlacePin = memo(function PlacePin({
  place,
  selected,
  onSelect,
}: {
  place: Place
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <Marker
      position={[place.lat, place.lon]}
      icon={selected ? selectedMarker : normalMarker}
      eventHandlers={{
        click: () => onSelect(place.id),
      }}
    />
  )
})

// MAPNIFIQUE — CLUSTER PRECISION ROUTE V1
function MapPlaceLayer({
  places,
  selectedId,
  onSelect,
}: {
  places: Place[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const map = useMap()
  const [viewState, setViewState] = useState(() => ({
    center: map.getCenter(),
    zoom: map.getZoom(),
  }))

  useMapEvents({
    zoomend: () => setViewState({ center: map.getCenter(), zoom: map.getZoom() }),
    moveend: () => setViewState({ center: map.getCenter(), zoom: map.getZoom() }),
  })

  const groups = useMemo(() => {
    if (places.length <= 1 || viewState.zoom >= 17) {
      return places.map((place) => [place])
    }

    const cellSize = viewState.zoom >= 15 ? 78 : 64
    const size = map.getSize()
    const centerPixel = map.project(viewState.center, viewState.zoom)
    const bins = new Map<string, Place[]>()

    for (const place of places) {
      const projected = map.project([place.lat, place.lon], viewState.zoom)
      const pixel = {
        x: projected.x - centerPixel.x + size.x / 2,
        y: projected.y - centerPixel.y + size.y / 2,
      }
      const key = `${Math.floor(pixel.x / cellSize)}:${Math.floor(pixel.y / cellSize)}`
      const group = bins.get(key) || []
      group.push(place)
      bins.set(key, group)
    }

    return Array.from(bins.values())
  }, [map, places, viewState])

  return (
    <>
      {groups.map((group) => {
        if (group.length === 1) {
          const place = group[0]
          return (
            <PlacePin
              key={place.id}
              place={place}
              selected={selectedId === place.id}
              onSelect={onSelect}
            />
          )
        }

        const center: [number, number] = [
          group.reduce((sum, place) => sum + place.lat, 0) / group.length,
          group.reduce((sum, place) => sum + place.lon, 0) / group.length,
        ]

        const bounds = L.latLngBounds(
          group.map((place) => [place.lat, place.lon] as [number, number]),
        )

        const icon = L.divIcon({
          className: 'map-cluster-shell',
          html: `<div class="map-cluster"><span>${group.length}</span></div>`,
          iconSize: [48, 48],
          iconAnchor: [24, 24],
        })

        return (
          <Marker
            key={`cluster-${group.map((place) => place.id).sort().join('-')}`}
            position={center}
            icon={icon}
            keyboard={false}
            eventHandlers={{
              click: () => {
                const diagonal = bounds
                  .getSouthWest()
                  .distanceTo(bounds.getNorthEast())

                if (diagonal < 12) {
                  onSelect(group[0].id)
                  return
                }

                map.fitBounds(bounds, {
                  padding: [85, 85],
                  maxZoom: Math.min(19, map.getZoom() + 3),
                  animate: true,
                })
              },
            }}
          />
        )
      })}
    </>
  )
}

function readFavorites(): string[] {
  try {
    const value = localStorage.getItem('mapnifique-v2-favorites')
    const parsed: unknown = value ? JSON.parse(value) : []
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}


// MAPNIFIQUE — DESTINATION COMPASS PHASE 4
function getBearingDegrees(from: Point, to: Point): number {
  const rad = Math.PI / 180
  const lat1 = from.lat * rad
  const lat2 = to.lat * rad
  const deltaLon = (to.lon - from.lon) * rad

  const y = Math.sin(deltaLon) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon)

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function getDistanceMeters(from: Point, to: Point): number {
  const rad = Math.PI / 180
  const lat1 = from.lat * rad
  const lat2 = to.lat * rad
  const deltaLat = (to.lat - from.lat) * rad
  const deltaLon = (to.lon - from.lon) * rad

  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(deltaLon / 2) ** 2

  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function formatCompassDistance(meters: number): string {
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(1).replace('.', ',')} km`
}

function geolocationErrorMessage(error: GeolocationPositionError): string {
  switch (error.code) {
    case 1:
      return "L'accès à votre position est refusé. Autorisez la localisation pour MapNifique dans les réglages du navigateur et de l'appareil."
    case 2:
      return "Votre appareil ne parvient pas à déterminer sa position. Vérifiez que les services de localisation et le Wi-Fi ou réseau mobile sont activés."
    case 3:
      return "La localisation prend trop de temps. La tentative standard a également échoué. Réessayez dans une zone avec une meilleure réception."
    default:
      return error.message || "La position n'a pas pu être déterminée."
  }
}

function App() {
  const [places, setPlaces] = useState<Place[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [userPoint, setUserPoint] = useState<Point | null>(null)
  const [gpsTrackingEnabled, setGpsTrackingEnabled] = useState(false)
  const [userHeading, setUserHeading] = useState<number | null>(null)
  const [compassAccess, setCompassAccess] = useState<'unknown' | 'granted' | 'denied'>('unknown')
  const [mapCenter, setMapCenter] = useState<Point>(DEFAULT_CENTER)
  const [mapRecenterRequest, setMapRecenterRequest] = useState(0)
  const [radius, setRadius] = useState(DEFAULT_RADIUS)
  const [searchMode, setSearchMode] = useState<SearchMode>('smart')
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('Tout')
  const [activeSection, setActiveSection] = useState<
    'places' | 'deals' | 'products' | 'favorites'
  >('places')
  const [favorites, setFavorites] = useState<string[]>(readFavorites)
  const [loading, setLoading] = useState(false)
  const [offersLoading, setOffersLoading] = useState(false)
  const [directionsOpen, setDirectionsOpen] = useState(false)
  const [travelMode, setTravelMode] = useState<TravelMode>('auto')
  const [routeState, setRouteState] = useState<RouteState | null>(null)
  const [apiError, setApiError] = useState('')
  const [emptyMessage, setEmptyMessage] = useState('')
  const [gpsStatus, setGpsStatus] = useState<
    'idle' | 'loading' | 'ready' | 'denied' | 'unavailable'
  >('idle')
  const [gpsError, setGpsError] = useState('')
  const [offers, setOffers] = useState<OffersPayload>(EMPTY_OFFERS)
  const [nearbyOffersByBrand, setNearbyOffersByBrand] = useState<Record<string, Offer[]>>({})
  const [nearbyPromoPlaces, setNearbyPromoPlaces] = useState<Place[]>([])
  const [nearbyDealsLoading, setNearbyDealsLoading] = useState(false)
  const [nearbyDealsError, setNearbyDealsError] = useState('')
  const [catalogOffers, setCatalogOffers] = useState<Offer[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [suggestionSnapshot, setSuggestionSnapshot] = useState<{
    key: string
    places: Place[]
    correction: string
  } | null>(null)
  const [suggestionsLoadingKey, setSuggestionsLoadingKey] = useState<string | null>(null)
  const suggestionTerm = query.trim()
  const suggestionCenterLat = userPoint?.lat ?? mapCenter.lat
  const suggestionCenterLon = userPoint?.lon ?? mapCenter.lon
  const nearbyDealsOriginLat = userPoint?.lat ?? mapCenter.lat
  const nearbyDealsOriginLon = userPoint?.lon ?? mapCenter.lon
  const suggestionSearchKey = JSON.stringify([
    suggestionTerm,
    searchMode,
    radius,
    searchMode === 'global' ? null : [suggestionCenterLat, suggestionCenterLon],
  ])
  const currentSuggestionSnapshot =
    suggestionsOpen && suggestionTerm.length >= 2 &&
    suggestionSnapshot?.key === suggestionSearchKey
      ? suggestionSnapshot
      : null
  const searchSuggestions = currentSuggestionSnapshot?.places ?? []
  const searchCorrection = currentSuggestionSnapshot?.correction ?? ''
  const suggestionsLoading =
    suggestionsOpen && suggestionTerm.length >= 2 &&
    suggestionsLoadingKey === suggestionSearchKey

  // Suggestions de commerces et d'adresses, avec annulation des requêtes
  // précédentes côté navigateur et temporisation pendant la saisie.
  useEffect(() => {
    const term = suggestionTerm
    if (!suggestionsOpen || term.length < 2) return

    const controller = new AbortController()
    let disposed = false

    const timer = window.setTimeout(async () => {
      setSuggestionsLoadingKey(suggestionSearchKey)

      try {
        const params = new URLSearchParams({
          q: term,
          mode: searchMode,
          suggest: '1',
          limit: '6',
        })

        const center = { lat: suggestionCenterLat, lon: suggestionCenterLon }

        if (searchMode !== 'global') {
          params.set('lat', String(center.lat))
          params.set('lon', String(center.lon))
          params.set('radiusM', String(radius))
        }

        const response = await fetch(
          `${API_BASE}/api/search/intelligent?${params}`,
          { signal: controller.signal },
        )

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const payload: unknown = await response.json()
        if (disposed) return

        const data = asRecord(payload)
        const actualMode = asText(data.mode)
        const origin = actualMode === 'nearby' ? center : null

        const normalized = extractPlaceRows(payload)
          .map((row, index) => normalizePlace(row, index, origin))
          .filter((place): place is Place => place !== null)

        const correction = asRecord(data.correction)
        const from = asText(correction.from)
        const to = asText(correction.to)
        setSuggestionSnapshot({
          key: suggestionSearchKey,
          places: normalized.slice(0, 6),
          correction: from && to ? `${from} → ${to}` : '',
        })
      } catch (error) {
        if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) {
          console.warn('Suggestions MapNifique indisponibles.', error)
          setSuggestionSnapshot({ key: suggestionSearchKey, places: [], correction: '' })
        }
      } finally {
        if (!disposed) {
          setSuggestionsLoadingKey((current) => (
            current === suggestionSearchKey ? null : current
          ))
        }
      }
    }, 650)

    return () => {
      disposed = true
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [
    suggestionTerm,
    suggestionSearchKey,
    searchMode,
    suggestionsOpen,
    suggestionCenterLat,
    suggestionCenterLon,
    radius,
  ])

  useEffect(() => {
    if (activeSection !== 'products') return

    const controller = new AbortController()
    let disposed = false
    let inFlight = false
    let firstLoad = true

    const loadCatalog = async () => {
      if (disposed || inFlight) return
      inFlight = true
      if (firstLoad) setCatalogLoading(true)

      try {
        const response = await fetch(
          `${API_BASE}/api/offers?merchantKey=lidl`,
          { signal: controller.signal },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const data = asRecord(await response.json())
        const catalogues = [
          ...rowsFromOffers(data.brandOffers),
          ...rowsFromOffers(data.onlineOffers),
        ].filter(
          offer => Array.isArray(offer.catalogItems) && offer.catalogItems.length > 0,
        )

        if (!disposed) {
          setCatalogOffers(catalogues)
          setCatalogError(
            catalogues.length
              ? ''
              : 'Aucun catalogue Lidl avec articles détaillés n’est actuellement disponible.',
          )
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError') && !disposed) {
          setCatalogError('Impossible de charger le catalogue Lidl. Vérifie la connexion au scraper.')
          console.warn('[MapNifique] Chargement du catalogue impossible.')
        }
      } finally {
        inFlight = false
        if (firstLoad) {
          firstLoad = false
          if (!disposed) setCatalogLoading(false)
        }
      }
    }

    void loadCatalog()

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadCatalog()
    }, 5 * 60 * 1000)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void loadCatalog()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      controller.abort()
    }
  }, [activeSection])

  const selectedPlace = places.find((place) => place.id === selectedId) || null
  const selectedOfferPlaceId = selectedPlace?.id ?? null
  const selectedOfferBrand = selectedPlace?.brand ?? ''
  const selectedOfferBrandKey = selectedPlace?.brandKey ?? ''
  const selectedOfferLat = selectedPlace?.lat ?? null
  const selectedOfferLon = selectedPlace?.lon ?? null
  const routeDestinationId = selectedPlace?.id ?? null
  const routeDestinationLat = selectedPlace?.lat ?? null
  const routeDestinationLon = selectedPlace?.lon ?? null
  const routeOriginLat = userPoint?.lat ?? null
  const routeOriginLon = userPoint?.lon ?? null
  const routeRequestReady =
    directionsOpen &&
    routeDestinationId !== null &&
    routeDestinationLat !== null &&
    routeDestinationLon !== null &&
    routeOriginLat !== null &&
    routeOriginLon !== null
  const routeRequestKey = JSON.stringify([
    routeDestinationId,
    routeDestinationLat,
    routeDestinationLon,
    routeOriginLat,
    routeOriginLon,
    travelMode,
  ])
  const activeRouteState = routeState?.key === routeRequestKey ? routeState : null
  const routeResult = activeRouteState?.result ?? null
  const routeError = activeRouteState?.error ?? ''
  const routeLoading = routeRequestReady && activeRouteState === null
  const routeNeedsOrigin =
    directionsOpen && routeDestinationId !== null && routeOriginLat === null
  const visibleRouteError = routeNeedsOrigin
    ? 'Active ta position pour calculer un itinéraire depuis ton emplacement.'
    : routeError
  const visibleRouteLoading = !routeNeedsOrigin && routeLoading
  const visibleRouteResult = routeNeedsOrigin ? null : routeResult
  const destinationCompassBearing =
    userPoint && selectedPlace
      ? getBearingDegrees(userPoint, selectedPlace)
      : null
  const destinationDistanceMeters =
    userPoint && selectedPlace
      ? getDistanceMeters(userPoint, selectedPlace)
      : null
  const destinationCompassRotation =
    destinationCompassBearing === null
      ? 0
      : (destinationCompassBearing - (userHeading ?? 0) + 360) % 360

  const selectPlace = useCallback((id: string) => {
    setDirectionsOpen(false)
    setRouteState(null)
    setOffers(EMPTY_OFFERS)
    setOffersLoading(false)
    setSelectedId(id)
  }, [])

  const loadPlaces = useCallback(async (
    center: Point,
    radiusM: number,
    searchTerm = '',
    categoryFilter = 'Tout',
    mode: SearchMode = searchMode,
    preserveMapView = false,
  ) => {
    setLoading(true)
    setApiError('')
    setEmptyMessage('')

    try {
      const cleanSearch = searchTerm.trim()

      if (cleanSearch.length === 1) {
        setPlaces([])
        setSelectedId(null)
        setEmptyMessage('Saisis au moins deux caractères pour lancer la recherche.')
        return
      }

      if (mode === 'global' && !cleanSearch && categoryFilter === 'Tout') {
        setPlaces([])
        setSelectedId(null)
        setEmptyMessage(
          'Saisis un commerce ou sélectionne une catégorie pour rechercher partout.',
        )
        return
      }

      const params = new URLSearchParams({
        mode,
        limit: '80',
      })

      if (mode !== 'global') {
        params.set('lat', String(center.lat))
        params.set('lon', String(center.lon))
        params.set('radiusM', String(radiusM))
      }

      if (cleanSearch) params.set('q', cleanSearch)

      if (categoryFilter && categoryFilter !== 'Tout') {
        params.set('category', categoryFilter)
      }

      const response = await fetch(`${API_BASE}/api/search/intelligent?${params}`)

      if (!response.ok) {
        throw new Error(`Le serveur des commerces répond HTTP ${response.status}.`)
      }

      const payload: unknown = await response.json()
      const externalError = asText(asRecord(payload).externalError)
      if (externalError) setEmptyMessage(externalError)

      const responseMode = asText(asRecord(payload).mode)
      const effectiveMode: SearchMode =
        responseMode === 'nearby' || responseMode === 'global'
          ? responseMode
          : mode

      const correction = asRecord(asRecord(payload).correction)
      const correctionFrom = asText(correction.from)
      const correctionTo = asText(correction.to)
      const correctionKey = JSON.stringify([
        searchTerm.trim(),
        mode,
        radiusM,
        mode === 'global' ? null : [center.lat, center.lon],
      ])
      setSuggestionSnapshot({
        key: correctionKey,
        places: [],
        correction: correctionFrom && correctionTo
          ? correctionFrom + ' → ' + correctionTo
          : '',
      })

      const rows = extractPlaceRows(payload)
      const origin = effectiveMode === 'nearby' ? center : null

      const normalized = rows
        .map((row, index) => normalizePlace(row, index, origin))
        .filter((place): place is Place => place !== null)

      if (effectiveMode === 'nearby') {
        normalized.sort(
          (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity),
        )
      }

      setPlaces(normalized)

      const displayCenter =
        normalized[0] && (effectiveMode === 'global' || cleanSearch)
          ? { lat: normalized[0].lat, lon: normalized[0].lon }
          : center

      if (!preserveMapView) {
        setMapCenter(displayCenter)
        setMapRecenterRequest((current) => current + 1)

        // Une recherche ne sélectionne jamais automatiquement un commerce.
        // On conserve uniquement une sélection utilisateur encore présente.
        setSelectedId((current) =>
          current && normalized.some((place) => place.id === current)
            ? current
            : null,
        )
      }

      if (normalized.length === 0) {
        setEmptyMessage(
          effectiveMode === 'nearby'
            ? 'Aucun commerce trouvé dans ce rayon parmi les données disponibles.'
            : 'Aucun résultat trouvé dans les données cartographiques actuellement importées.',
        )
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erreur inconnue lors du chargement.'
      setApiError(
        `${message} Vérifie que le scraper fonctionne sur ${API_BASE}.`,
      )
    } finally {
      setLoading(false)
    }
  }, [searchMode])

  const locateMe = useCallback(async () => {
    if (!navigator.geolocation) {
      setGpsStatus('unavailable')
      setGpsError("Ce navigateur ne permet pas d'accéder à la géolocalisation.")
      return
    }

    setGpsStatus('loading')
    setGpsError('')

    const attempts: PositionOptions[] = [
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 30000,
      },
      {
        enableHighAccuracy: false,
        timeout: 20000,
        maximumAge: 120000,
      },
    ]

    let lastError: GeolocationPositionError | null = null

    for (const options of attempts) {
      try {
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, options)
        })

        const point = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        }

        setUserPoint(point)
        if (position.coords.heading !== null && Number.isFinite(position.coords.heading)) {
          setUserHeading(position.coords.heading)
        }
        setMapCenter(point)
        setMapRecenterRequest((current) => current + 1)
        setGpsStatus('ready')
        setGpsError('')
        setGpsTrackingEnabled(true)

        if (searchMode !== 'global') {
          void loadPlaces(point, radius, '', activeCategory, 'nearby')
        }
        return
      } catch (error) {
        lastError = error as GeolocationPositionError

        // Un refus explicite ne doit pas déclencher une nouvelle demande.
        if (lastError.code === 1) break
      }
    }

    setGpsStatus(lastError?.code === 1 ? 'denied' : 'unavailable')
    setGpsError(
      lastError
        ? geolocationErrorMessage(lastError)
        : "Impossible de déterminer votre position.",
    )
  }, [loadPlaces, radius, searchMode, activeCategory])

  useEffect(() => {
    if (!gpsTrackingEnabled) return

    if (!navigator.geolocation) {
      return
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const point = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        }

        setUserPoint(point)
        setGpsStatus('ready')

        if (
          position.coords.heading !== null &&
          Number.isFinite(position.coords.heading)
        ) {
          setUserHeading(position.coords.heading)
        }

        if (searchMode !== 'global') {
          void loadPlaces(point, DEFAULT_RADIUS, '', activeCategory, 'nearby', true)
        }
      },
      (error) => {
        if (error.code === 1) {
          setGpsStatus('denied')
          setGpsError(geolocationErrorMessage(error))
        }
        // Une perte momentanée du signal ne supprime pas une position déjà obtenue.
      },
      {
        enableHighAccuracy: false,
        timeout: 30000,
        maximumAge: 30000,
      },
    )

    const handleOrientation = (event: DeviceOrientationEvent) => {
      const compassEvent = event as DeviceOrientationEvent & {
        webkitCompassHeading?: number
      }

      if (
        typeof compassEvent.webkitCompassHeading === 'number' &&
        Number.isFinite(compassEvent.webkitCompassHeading)
      ) {
        setUserHeading(compassEvent.webkitCompassHeading)
        setCompassAccess('granted')
      } else if (event.absolute && event.alpha !== null) {
        setUserHeading((360 - event.alpha + 360) % 360)
        setCompassAccess('granted')
      }
    }

    window.addEventListener('deviceorientation', handleOrientation)

    return () => {
      navigator.geolocation.clearWatch(watchId)
      window.removeEventListener('deviceorientation', handleOrientation)
    }
  }, [gpsTrackingEnabled, loadPlaces, activeCategory, searchMode])

  useEffect(() => {
    try {
      localStorage.setItem('mapnifique-v2-favorites', JSON.stringify(favorites))
    } catch {
      // Les favoris restent disponibles en mémoire si le stockage est bloqué.
    }
  }, [favorites])

  useEffect(() => {
    if (
      selectedOfferPlaceId === null ||
      selectedOfferLat === null ||
      selectedOfferLon === null
    ) return

    let disposed = false
    let requestInFlight = false
    let activeController: AbortController | null = null

    const params = new URLSearchParams({
      merchantKey: selectedOfferBrandKey || slug(selectedOfferBrand),
      lat: String(selectedOfferLat),
      lon: String(selectedOfferLon),
    })

    if (/^\d+$/.test(selectedOfferPlaceId)) {
      params.set('placeId', selectedOfferPlaceId)
    }

    const loadOffers = async (showLoading: boolean) => {
      if (disposed || requestInFlight) return

      requestInFlight = true
      const controller = new AbortController()
      activeController = controller

      if (showLoading) setOffersLoading(true)

      try {
        const response = await fetch(`${API_BASE}/api/offers?${params}`, {
          signal: controller.signal,
        })

        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const data = asRecord(await response.json())

        if (!disposed && !controller.signal.aborted) {
          setOffers({
            storeOffers: rowsFromOffers(data.storeOffers),
            brandOffers: rowsFromOffers(data.brandOffers),
            onlineOffers: rowsFromOffers(data.onlineOffers),
            cashbackOffers: rowsFromOffers(data.cashbackOffers),
          })
        }
      } catch (error: unknown) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          // Conserve les dernières offres affichées en cas de panne temporaire.
          console.warn('[MapNifique] Actualisation des offres impossible.')
        }
      } finally {
        requestInFlight = false

        if (!disposed && activeController === controller) {
          activeController = null
          setOffersLoading(false)
        }
      }
    }

    void loadOffers(true)

    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadOffers(false)
      }
    }, 5 * 60 * 1000)

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadOffers(false)
      }
    }

    const handleFocus = () => {
      if (document.visibilityState === 'visible') {
        void loadOffers(false)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      disposed = true
      window.clearInterval(refreshInterval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
      activeController?.abort()
    }
  }, [
    selectedOfferPlaceId,
    selectedOfferBrand,
    selectedOfferBrandKey,
    selectedOfferLat,
    selectedOfferLon,
  ])

  useEffect(() => {
    if (!routeRequestReady) return

    const controller = new AbortController();
    const params = new URLSearchParams({
      originLat: String(routeOriginLat),
      originLon: String(routeOriginLon),
      destinationLat: String(routeDestinationLat),
      destinationLon: String(routeDestinationLon),
      mode: travelMode,
    });

    fetch(`${API_BASE}/api/route?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = asRecord(await response.json());
        if (!response.ok) {
          throw new Error(asText(payload.error) || `Erreur itinéraire HTTP ${response.status}`);
        }
        return asRecord(payload.route);
      })
      .then((route) => {
        const distanceKm = Number(route.distanceKm);
        const durationSeconds = Number(route.durationSeconds);
        const shape = asText(route.shape);

        if (!Number.isFinite(distanceKm) || !Number.isFinite(durationSeconds) || !shape) {
          throw new Error('Le moteur n’a pas renvoyé de tracé complet.');
        }

        const rawSteps = Array.isArray(route.steps) ? route.steps : [];
        const steps: RouteStep[] = rawSteps.map((item) => {
          const step = asRecord(item);
          return {
            instruction: asText(step.instruction) || 'Continuer',
            distanceKm: Number(step.distanceKm || 0),
            durationSeconds: Number(step.durationSeconds || 0),
            type: Number(step.type || 0),
          };
        });

        if (!controller.signal.aborted) {
          setRouteState({
            key: routeRequestKey,
            result: {
              distanceKm,
              durationSeconds,
              shape,
              steps,
              source: asText(route.source),
            },
          })
        }
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          error instanceof Error && error.name === 'AbortError'
        ) return
        setRouteState({
          key: routeRequestKey,
          error: error instanceof Error ? error.message : 'Impossible de calculer ce trajet.',
        })
      });

    return () => controller.abort();
  }, [
    routeRequestReady,
    routeRequestKey,
    routeOriginLat,
    routeOriginLon,
    routeDestinationLat,
    routeDestinationLon,
    travelMode,
  ]);

  const visiblePlaces = useMemo(() => {
    return places.filter((place) => {
      const matchesCategory = categoryMatches(place, activeCategory)
      const matchesFavorite =
        activeSection !== 'favorites' || favorites.includes(place.id)

      return matchesCategory && matchesFavorite
    })
  }, [places, activeCategory, activeSection, favorites])

  const offerGroups = [
    {
      key: 'storeOffers',
      title: 'Dans ce magasin',
      description: 'Offres rattachées à ce point de vente',
      items: offers.storeOffers,
    },
    {
      key: 'brandOffers',
      title: 'Offres de l’enseigne',
      description: 'Offres nationales de la marque',
      items: offers.brandOffers,
    },
    {
      key: 'onlineOffers',
      title: 'Offres en ligne',
      description: 'Promotions utilisables sur internet',
      items: offers.onlineOffers,
    },
    {
      key: 'cashbackOffers',
      title: 'Cashback',
      description: 'Remboursement ou remise partenaire',
      items: offers.cashbackOffers,
    },
  ]

  const offerCount = Object.values(offers).reduce(
    (total, items) => total + items.length,
    0,
  )

  useEffect(() => {
    if (activeSection !== 'deals') return

    let disposed = false
    let inFlight = false
    let firstLoad = true
    const controller = new AbortController()

    const loadNearbyDeals = async () => {
      if (disposed || inFlight) return
      inFlight = true
      if (firstLoad) setNearbyDealsLoading(true)

      try {
        const origin = { lat: nearbyDealsOriginLat, lon: nearbyDealsOriginLon }

        const brandsResponse = await fetch(
          `${API_BASE}/api/offers/brands`,
          { signal: controller.signal },
        )
        if (!brandsResponse.ok) {
          throw new Error(`API enseignes HTTP ${brandsResponse.status}`)
        }

        const brandsData = asRecord(await brandsResponse.json())
        const brandKeys = Array.isArray(brandsData.brands)
          ? [...new Set(
              brandsData.brands
                .map(value => String(value).trim().toLowerCase())
                .filter(key => /^[a-z0-9][a-z0-9-]{0,99}$/.test(key)),
            )].slice(0, 20)
          : []

        if (!brandKeys.length) {
          if (!disposed) {
            setNearbyPromoPlaces([])
            setNearbyOffersByBrand({})
            setNearbyDealsError('')
          }
          return
        }

        const params = new URLSearchParams({
          lat: String(origin.lat),
          lon: String(origin.lon),
          radiusM: String(radius),
          limit: '100',
          q: brandKeys.join('|'),
          localOnly: '1',
        })

        const placesResponse = await fetch(
          `${API_BASE}/api/discover?${params}`,
          { signal: controller.signal },
        )
        if (!placesResponse.ok) {
          throw new Error(`API commerces HTTP ${placesResponse.status}`)
        }

        const placesData: unknown = await placesResponse.json()
        const discoveryError = asText(asRecord(placesData).externalError)

        const normalizedPlaces = extractPlaceRows(placesData)
          .map((place, index) => normalizePlace(place, index, origin))
          .filter((place): place is Place => (
            place !== null &&
            brandKeys.includes(place.brandKey.toLowerCase())
          ))
          .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))

        let offerFailures = 0

        const entries: BrandOfferEntry[] = await Promise.all(
          brandKeys.map(async (brandKey): Promise<BrandOfferEntry> => {
            try {
              const offerParams = new URLSearchParams({
                merchantKey: brandKey,
                lat: String(origin.lat),
                lon: String(origin.lon),
                radiusM: String(radius),
              })
              const response = await fetch(
                `${API_BASE}/api/offers?${offerParams}`,
                { signal: controller.signal },
              )
              if (!response.ok) throw new Error(`HTTP ${response.status}`)

              const data = asRecord(await response.json())
              const items = [
                ...rowsFromOffers(data.brandOffers),
                ...rowsFromOffers(data.onlineOffers),
                ...rowsFromOffers(data.cashbackOffers),
              ]
              const storeItems = rowsFromOffers(data.storeOffers)
              return [brandKey, items, storeItems]
            } catch (error) {
              if (error instanceof Error && error.name === 'AbortError') {
                return [brandKey, [], []]
              }
              offerFailures += 1
              return [brandKey, [], []]
            }
          }),
        )

        if (!disposed && !controller.signal.aborted) {
          const offersByKey: Record<string, Offer[]> = {}
          for (const [brandKey, brandOffers, storeOffers] of entries) {
            offersByKey[brandKey] = brandOffers
            for (const offer of storeOffers) {
              const placeId = String(offer.placeId ?? '').trim()
              if (!/^\d+$/.test(placeId)) continue
              const placeKey = `place:${placeId}`
              offersByKey[placeKey] ||= []
              offersByKey[placeKey].push(offer)
            }
          }
          setNearbyPromoPlaces(normalizedPlaces)
          setNearbyOffersByBrand(offersByKey)
          setNearbyDealsError(
            discoveryError ||
            (offerFailures === brandKeys.length
              ? 'Impossible de récupérer les promotions. Réessayez dans quelques instants.'
              : offerFailures > 0
                ? 'Certaines enseignes sont momentanément indisponibles.'
                : ''),
          )
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError') && !disposed) {
          setNearbyDealsError(
            'Impossible de rechercher les magasins en promotion. Vérifie la connexion au scraper.',
          )
          console.warn('[MapNifique] Recherche géolocalisée des promotions impossible.')
        }
      } finally {
        inFlight = false
        if (firstLoad) {
          firstLoad = false
          if (!disposed) setNearbyDealsLoading(false)
        }
      }
    }

    void loadNearbyDeals()

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadNearbyDeals()
    }, 5 * 60 * 1000)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void loadNearbyDeals()
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      controller.abort()
    }
  }, [
    activeSection,
    nearbyDealsOriginLat,
    nearbyDealsOriginLon,
    radius,
  ])

  const nearbyDealGroups = useMemo(() => {
    return nearbyPromoPlaces
      .filter(place => categoryMatches(place, activeCategory))
      .map(place => {
        const brandKey = (place.brandKey || slug(place.brand)).toLowerCase()
        const storeItems = nearbyOffersByBrand[`place:${place.id}`] || []
        const brandItems = nearbyOffersByBrand[brandKey] || []
        const seenOfferIds = new Set<string>()
        const items = [...storeItems, ...brandItems].filter((offer, index) => {
          const key = String(offer.id ?? `${offer.title ?? 'offer'}:${index}`)
          if (seenOfferIds.has(key)) return false
          seenOfferIds.add(key)
          return true
        })
        return { place, items }
      })
      .filter(group => group.items.length > 0)
      .sort((a, b) => (a.place.distance ?? Infinity) - (b.place.distance ?? Infinity))
  }, [nearbyPromoPlaces, nearbyOffersByBrand, activeCategory])

  const toggleFavorite = (id: string) => {
    setFavorites((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    )
  }

  const searchThisArea = () => {
    void loadPlaces(mapCenter, radius, query.trim(), query.trim() ? 'Tout' : activeCategory)
  }

  const selectSearchSuggestion = (place: Place) => {
    const subject = place.brand || place.name

    const location = place.address === 'Adresse non renseignée'
      ? ''
      : place.address
          .split(',')
          .map(part => part.trim())
          .filter(part =>
            part &&
            !/^\d{4,6}$/.test(part) &&
            normalizeText(part) !== 'france',
          )
          .join(' ')

    const selectedQuery = [subject, location]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    setQuery(selectedQuery)
    setSearchMode('global')
    setSuggestionsOpen(false)
    setSuggestionSnapshot(null)
    setActiveSection('places')
    setActiveCategory('Tout')
    setDirectionsOpen(false)

    void loadPlaces(
      mapCenter,
      radius,
      selectedQuery,
      'Tout',
      'global',
    )
  }

  const routeShape = routeResult?.shape ?? ''
  const hasUserPoint = userPoint !== null
  const routeCoordinates = useMemo(
    () => directionsOpen && hasUserPoint && routeShape
      ? decodeValhallaShape(routeShape, 6)
      : [],
    [directionsOpen, hasUserPoint, routeShape],
  )

  const openDirections = () => {
    setDirectionsOpen(true)
    setRouteState(null)
    setTravelMode('auto')
  }

  const selectedWebsite = selectedPlace ? safeUrl(selectedPlace.website) : ''
  const selectedPhone = selectedPlace?.phone || ''
  const detailTouchStart = useRef<{ x: number; y: number } | null>(null)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-symbol" aria-hidden="true">
            <svg className="brand-monogram" viewBox="0 0 64 64" fill="none">
              <path d="M32 7.5C20.4 7.5 11 16.9 11 28.5 11 42.4 32 57 32 57s21-14.6 21-28.5C53 16.9 43.6 7.5 32 7.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
              <path d="M19 36V21.5L32 32l13-10.5V36" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="32" cy="15.5" r="2" fill="currentColor"/>
            </svg>
          </div>
          <div>
            <div className="brand-name">MapNifique</div>
            <div className="brand-caption">ADRESSES & BONNES AFFAIRES</div>
          </div>
        </div>

        <form
          className="global-search"
          onSubmit={(event) => {
            event.preventDefault()
            setSuggestionsOpen(false)
            setSuggestionSnapshot(null)
            setActiveSection('places')
            setActiveCategory('Tout')
            setDirectionsOpen(false)
            void loadPlaces(userPoint || mapCenter, radius, query.trim(), 'Tout')
          }}
        >
          <select
            className="search-mode-select"
            aria-label="Mode de recherche"
            value={searchMode}
            onChange={(event) => {
              setSearchMode(event.target.value as SearchMode)
              setSuggestionsOpen(false)
            }}
          >
            <option value="smart">Intelligente</option>
            <option value="nearby">Autour de moi</option>
            <option value="global">Partout</option>
          </select>
          <Search size={19} />
          <input
            aria-label="Rechercher un commerce ou une catégorie"
            placeholder="Une adresse, une enseigne, une envie…"
            value={query}
            onFocus={() => setSuggestionsOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value)
              setSuggestionsOpen(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSuggestionsOpen(false)
              }
            }}
          />
          {query && (
            <button
              className="clear-search"
              type="button"
              aria-label="Effacer la recherche"
              onClick={() => {
                setQuery('')
                setSuggestionsOpen(false)
                setSuggestionSnapshot(null)
                void loadPlaces(userPoint || mapCenter, radius, '', activeCategory)
              }}
            >
              <X size={16} />
            </button>
          )}
          <button className="search-submit" type="submit">
            Découvrir
          </button>

          {suggestionsOpen && query.trim().length >= 2 && (
            <div
              className="search-suggestions"
              role="listbox"
              aria-label="Suggestions de commerces et d'adresses"
            >
              {searchCorrection && (
                <div className="search-correction">
                  Recherche corrigée :
                  <strong>{searchCorrection}</strong>
                </div>
              )}

              {suggestionsLoading && (
                <div className="search-suggestion-status">
                  Recherche des meilleures correspondances…
                </div>
              )}

              {searchSuggestions.map((place) => (
                <button
                  type="button"
                  className="search-suggestion"
                  role="option"
                  aria-selected="false"
                  key={place.id}
                  onClick={() => selectSearchSuggestion(place)}
                >
                  <span className="search-suggestion-icon">
                    <Store size={16} />
                  </span>
                  <span className="search-suggestion-copy">
                    <strong>{place.name}</strong>
                    <small>
                      {[place.category, place.address]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}

              {!suggestionsLoading && searchSuggestions.length === 0 && (
                <div className="search-suggestion-status">
                  Aucun résultat suggéré. Valide la recherche pour élargir les correspondances.
                </div>
              )}
            </div>
          )}
        </form>

        <button className="location-status" onClick={locateMe} type="button">
          <span className={`status-dot ${gpsStatus === 'ready' ? 'is-ready' : ''}`} />
          {gpsStatus === 'ready'
            ? 'Position activée'
            : gpsStatus === 'loading'
              ? 'Localisation…'
              : 'Activer ma position'}
          <LocateFixed size={17} />
        </button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-main">
            <button
              className={`side-link ${activeSection === 'places' ? 'active' : ''}`}
              onClick={() => setActiveSection('places')}
              type="button"
              title="Explorer la carte"
            >
              <Compass size={21} />
              <span>Explorer</span>
            </button>
            <button
              className={`side-link ${activeSection === 'deals' ? 'active' : ''}`}
              onClick={() => {
                setActiveSection('deals')
                setSelectedId(null)
                setDirectionsOpen(false)
                setQuery('')
                setActiveCategory('Tout')
                void loadPlaces(userPoint || mapCenter, radius, '', 'Tout', 'nearby')
              }}
              type="button"
              title="Promotions"
            >
              <Tag size={21} />
              <span>Promos</span>
            </button>
            <button
              className={`side-link ${activeSection === 'products' ? 'active' : ''}`}
              onClick={() => setActiveSection('products')}
              type="button"
              title="Produits"
            >
              <ShoppingBag size={21} />
              <span>Produits</span>
            </button>
            <button
              className={`side-link ${activeSection === 'favorites' ? 'active' : ''}`}
              onClick={() => setActiveSection('favorites')}
              type="button"
              title="Favoris"
            >
              <Heart size={21} />
              <span>Favoris</span>
            </button>
          </div>
          <div className="sidebar-bottom">
            <div className="sidebar-avatar">M</div>
            <span>V2</span>
          </div>
        </aside>

        <section className="results-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">
                {activeSection === 'favorites'
                  ? 'VOTRE SÉLECTION'
                  : activeSection === 'deals'
                    ? 'ÉCONOMIES'
                    : activeSection === 'products'
                      ? 'CATALOGUE'
                      : 'À PROXIMITÉ'}
              </div>
              <h1>
                {activeSection === 'favorites'
                  ? 'Mes favoris'
                  : activeSection === 'deals'
                    ? 'Promotions'
                    : activeSection === 'products'
                      ? 'Produits'
                      : 'Explorer'}
              </h1>
              <p>
                {activeSection === 'places'
                  ? 'Découvrez les commerces autour de vous.'
                  : activeSection === 'favorites'
                    ? 'Retrouvez vos commerces enregistrés.'
                    : activeSection === 'deals'
                      ? 'Les offres sont affichées lorsqu’elles sont vérifiées.'
                      : 'Le catalogue produits sera connecté à une source dédiée.'}
              </p>
            </div>
            <button
              className="icon-button refresh-button"
              onClick={() => {
                if (userPoint) void loadPlaces(userPoint, radius)
                else locateMe()
              }}
              type="button"
              title="Actualiser"
            >
              <RefreshCw size={17} />
            </button>
          </div>

          {directionsOpen && selectedPlace ? (
            <div className="directions-panel">
              <div className="directions-panel-heading">
                <div>
                  <div className="eyebrow">VOTRE ITINÉRAIRE</div>
                  <h2>Vers {selectedPlace.name}</h2>
                </div>
                <button
                  type="button"
                  className="icon-button refresh-button"
                  aria-label="Fermer l’itinéraire"
                  onClick={() => setDirectionsOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>

              <div className="route-endpoints">
                <div><span className="route-origin-dot" /> Votre position</div>
                <div><span className="route-destination-pin" /> {selectedPlace.name}</div>
              </div>

              <div className="travel-modes" aria-label="Mode de déplacement">
                {([
                  ['auto', 'Voiture'],
                  ['pedestrian', 'À pied'],
                  ['bicycle', 'Vélo'],
                  ['multimodal', 'Transports'],
                ] as [TravelMode, string][]).map(([mode, label]) => (
                  <button
                    type="button"
                    key={mode}
                    className={`travel-mode ${travelMode === mode ? 'selected' : ''}`}
                    onClick={() => setTravelMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {visibleRouteLoading && (
                <div className="route-status">
                  <span className="spinner" />
                  Calcul de l’itinéraire…
                </div>
              )}

              {visibleRouteError && (
                <div className="message-card error-card route-error">
                  <AlertCircle size={19} />
                  <div>
                    <strong>Itinéraire indisponible</strong>
                    <p>{visibleRouteError}</p>
                  </div>
                </div>
              )}

              {visibleRouteResult && (
                <>
                  <div className="route-summary">
                    <div>
                      <strong>{formatRouteDuration(visibleRouteResult.durationSeconds)}</strong>
                      <span>Durée estimée</span>
                    </div>
                    <div>
                      <strong>{formatRouteDistance(visibleRouteResult.distanceKm)}</strong>
                      <span>Distance</span>
                    </div>
                  </div>

                  <div className="route-directions-title">Étapes du trajet</div>
                  <ol className="route-steps">
                    {visibleRouteResult.steps.map((step, index) => (
                      <li key={`${index}-${step.instruction}`}>
                        <span className="route-step-number">{index + 1}</span>
                        <div>
                          <strong>{step.instruction}</strong>
                          <small>
                            {step.distanceKm >= 0.1
                              ? `${step.distanceKm.toFixed(1).replace('.', ',')} km`
                              : `${Math.round(step.distanceKm * 1000)} m`}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ol>
                  <p className="route-attribution">
                    Calcul fourni par Valhalla · données OpenStreetMap
                  </p>
                </>
              )}
            </div>
          ) : activeSection === 'places' || activeSection === 'favorites' ? (
            <>
              <div className="results-meta">
                <span>
                  {loading
                    ? 'Recherche des commerces…'
                    : `${visiblePlaces.length} commerce${visiblePlaces.length > 1 ? 's' : ''}`}
                </span>
                {searchMode === 'nearby' && (
                  <label className="radius-select">
                    <SlidersHorizontal size={14} />
                    <select
                      aria-label="Rayon de recherche"
                      value={radius}
                      onChange={(event) => setRadius(Number(event.target.value))}
                    >
                      <option value={1000}>1 km</option>
                      <option value={3000}>3 km</option>
                      <option value={5000}>5 km</option>
                      <option value={10000}>10 km</option>
                    </select>
                  </label>
                )}
              </div>

              {apiError && (
                <div className="message-card error-card">
                  <AlertCircle size={19} />
                  <div>
                    <strong>Connexion aux commerces impossible</strong>
                    <p>{apiError}</p>
                  </div>
                </div>
              )}

              {gpsError && !userPoint && (
                <div className="message-card error-card">
                  <LocateFixed size={19} />
                  <div>
                    <strong>
                      {gpsStatus === 'denied'
                        ? 'Autorisation de localisation refusée'
                        : 'Localisation momentanément indisponible'}
                    </strong>
                    <p>{gpsError}</p>
                  </div>
                </div>
              )}

              {loading && (
                <div className="loading-state">
                  <span className="spinner" />
                  <span>Chargement des commerces…</span>
                </div>
              )}

              {!loading && !apiError && visiblePlaces.length === 0 && (
                <div className="empty-state">
                  <div className="empty-icon">
                    <Store size={25} />
                  </div>
                  <strong>
                    {activeSection === 'favorites'
                      ? 'Aucun favori pour le moment'
                      : 'Aucun commerce à afficher'}
                  </strong>
                  <p>
                    {emptyMessage ||
                      'Enregistre un commerce avec le cœur pour le retrouver ici.'}
                  </p>
                  {!userPoint && (
                    <button className="primary-button" onClick={locateMe} type="button">
                      <LocateFixed size={16} />
                      Activer ma position
                    </button>
                  )}
                </div>
              )}

              <div className="place-list">
                {visiblePlaces.map((place) => (
                  <article
                    className={`place-card ${selectedId === place.id ? 'is-selected' : ''}`}
                    key={place.id}
                  >
                    <button
                      type="button"
                      className="place-card-main"
                      onClick={() => selectPlace(place.id)}
                    >
                      <div className="place-thumb">
                        {place.image && safeUrl(place.image) ? (
                          <img src={safeUrl(place.image)} alt="" loading="lazy" decoding="async" />
                        ) : (
                          <Store size={23} />
                        )}
                      </div>
                      <div className="place-card-copy">
                        <strong>{place.name}</strong>
                        <span>{place.category}</span>
                        <small>
                          {place.distance !== null
                            ? formatDistance(place.distance)
                            : 'Distance inconnue'}
                          {place.address !== 'Adresse non renseignée'
                            ? ` · ${place.address}`
                            : ''}
                        </small>
                      </div>
                      <ChevronRight className="place-chevron" size={18} />
                    </button>
                    <button
                      className={`favorite-button ${favorites.includes(place.id) ? 'is-favorite' : ''}`}
                      type="button"
                      aria-label={
                        favorites.includes(place.id)
                          ? 'Retirer des favoris'
                          : 'Ajouter aux favoris'
                      }
                      onClick={() => toggleFavorite(place.id)}
                    >
                      <Heart
                        size={17}
                        fill={favorites.includes(place.id) ? 'currentColor' : 'none'}
                      />
                    </button>
                  </article>
                ))}
              </div>
            </>
          ) : activeSection === 'deals' ? (
            <div className="deals-explorer">
              <div className="results-meta">
                <span>
                  {nearbyDealsLoading
                    ? 'Recherche des bons plans…'
                    : `${nearbyDealGroups.length} commerce${nearbyDealGroups.length > 1 ? 's' : ''} avec offres`}
                </span>
                <label className="radius-select">
                  <SlidersHorizontal size={14} />
                  <select
                    aria-label="Rayon des promotions"
                    value={radius}
                    onChange={(event) => {
                      const nextRadius = Number(event.target.value)
                      setRadius(nextRadius)
                      void loadPlaces(userPoint || mapCenter, nextRadius, '', activeCategory, 'nearby')
                    }}
                  >
                    <option value={1000}>1 km</option>
                    <option value={3000}>3 km</option>
                    <option value={5000}>5 km</option>
                    <option value={10000}>10 km</option>
                  </select>
                </label>
              </div>

              <div className="deals-category-filters">
                {categories.map(category => (
                  <button
                    key={category}
                    type="button"
                    className={activeCategory === category ? 'selected' : ''}
                    onClick={() => setActiveCategory(category)}
                  >
                    {category}
                  </button>
                ))}
              </div>

              {nearbyDealsError && (
                <div className="message-card error-card">
                  <AlertCircle size={18} />
                  <p>{nearbyDealsError}</p>
                </div>
              )}

              {nearbyDealsLoading && (
                <div className="loading-state">
                  <span className="spinner" />
                  <span>Recherche des offres autour de vous…</span>
                </div>
              )}

              {!nearbyDealsLoading && nearbyDealGroups.length === 0 && (
                <div className="empty-state deals-empty">
                  <div className="empty-icon deals-icon">
                    <BadgePercent size={25} />
                  </div>
                  <strong>Aucun bon plan vérifié dans ce rayon</strong>
                  <p>
                    Les commerces apparaîtront ici dès qu'une promotion active
                    et vérifiée sera disponible pour leur enseigne.
                  </p>
                  <div className="data-note">
                    <CheckCircle2 size={16} />
                    Seules les offres reliées à une source vérifiable sont affichées.
                  </div>
                </div>
              )}

              <div className="nearby-deal-list">
                {nearbyDealGroups.map(({ place, items }) => (
                  <article className="nearby-deal-place" key={place.id}>
                    <button
                      type="button"
                      className="nearby-deal-place-heading"
                      onClick={() => {
                        setPlaces(current => (
                          current.some(item => item.id === place.id)
                            ? current
                            : [...current, place]
                        ))
                        setMapCenter({ lat: place.lat, lon: place.lon })
                        setMapRecenterRequest((current) => current + 1)
                        selectPlace(place.id)
                      }}
                    >
                      <span className="nearby-deal-store-icon">
                        <Store size={19} />
                      </span>
                      <span className="nearby-deal-store-copy">
                        <strong>{place.name}</strong>
                        <small>
                          {place.distance !== null
                            ? formatDistance(place.distance)
                            : place.category}
                        </small>
                      </span>
                      <ChevronRight size={18} />
                    </button>

                    {items.map((offer, index) => {
                      const discount = offer.discountLabel || offer.discount_label
                      const validity = formatOfferValidity(
                        offer.validFrom || offer.valid_from,
                        offer.validUntil || offer.valid_until,
                      )
                      const link = safeUrl(
                        offer.landingUrl || offer.landing_url ||
                        offer.sourceUrl || offer.source_url || '',
                      )

                      return (
                        <div
                          className="nearby-deal-offer"
                          key={offer.id || `${place.id}-${index}`}
                        >
                          {discount && <span className="discount-label">{discount}</span>}
                          <strong>{offer.title || 'Promotion vérifiée'}</strong>
                          {offer.description && <p>{offer.description}</p>}
                          <CatalogItemList items={offer.catalogItems} limit={3} />
                          {offer.terms && <p className="nearby-deal-terms">{offer.terms}</p>}
                          <div className="offer-card-foot">
                            <span>
                              {validity || 'Offre vérifiée'}
                              {offer.sourceName ? ` · ${offer.sourceName}` : ''}
                            </span>
                            {link && (
                              <a href={link} target="_blank" rel="noreferrer">
                                Voir l’offre <ArrowUpRight size={13} />
                              </a>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </article>
                ))}
              </div>
            </div>
          ) : (
            <div className="product-catalog">
              {catalogLoading && catalogOffers.length === 0 && (
                <div className="loading-state">
                  <span className="spinner" />
                  <span>Chargement du catalogue officiel Lidl…</span>
                </div>
              )}

              {catalogError && (
                <div className="message-card error-card">
                  <AlertCircle size={18} />
                  <p>{catalogError}</p>
                </div>
              )}

              {catalogOffers.length > 0 ? (
                <>
                  {catalogOffers.map((catalogOffer, index) => {
                    const isOnline = catalogOffer.scope === 'online'
                    const isMixed = (
                      catalogOffer.discountLabel ||
                      catalogOffer.discount_label ||
                      ''
                    ).toLowerCase().includes('mixte')

                    const catalogueLink = safeUrl(
                      catalogOffer.landingUrl || catalogOffer.landing_url ||
                      catalogOffer.sourceUrl || catalogOffer.source_url || '',
                    )

                    const catalogueLabel = isOnline
                      ? 'CATALOGUE EXCLUSIVEMENT EN LIGNE'
                      : isMixed
                        ? 'CATALOGUE MIXTE · MAGASIN ET WEB'
                        : 'CATALOGUE MAGASIN'

                    return (
                      <details
                        className={[
                          'product-catalog-entry',
                          isOnline ? 'is-online' : '',
                          isMixed ? 'is-mixed' : '',
                        ].filter(Boolean).join(' ')}
                        key={catalogOffer.id || `${catalogOffer.title}-${index}`}
                        open={index === 0}
                      >
                        <summary className="product-catalog-summary">
                          <div className="product-catalog-heading">
                            <span className="product-catalog-eyebrow">
                              {catalogueLabel} · {catalogOffer.sourceName || 'Lidl France'}
                            </span>
                            <h2>{catalogOffer.title || 'Catalogue Lidl'}</h2>
                            <p>
                              {catalogOffer.description ||
                                `${catalogOffer.catalogItems?.length || 0} articles issus du catalogue officiel.`}
                            </p>
                            <div className="product-catalog-meta">
                              <span>
                                {formatOfferValidity(
                                  catalogOffer.validFrom || catalogOffer.valid_from,
                                  catalogOffer.validUntil || catalogOffer.valid_until,
                                )}
                              </span>
                              <span>
                                {catalogOffer.catalogItems?.length || 0} articles
                              </span>
                            </div>
                          </div>
                        </summary>

                        <div className="product-catalog-content">
                          {catalogueLink && (
                            <a
                              className="product-catalog-link"
                              href={catalogueLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {isOnline
                                ? 'Consulter la boutique en ligne'
                                : 'Consulter le catalogue officiel'}
                              {' '}
                              <ArrowUpRight size={14} />
                            </a>
                          )}

                          <CatalogItemList items={catalogOffer.catalogItems} />

                          <p className="product-catalog-disclaimer">
                            {isOnline
                              ? 'Ce catalogue est exclusivement réservé à la boutique en ligne Lidl. Ne pas considérer ces articles comme disponibles en magasin.'
                              : isMixed
                                ? 'Catalogue à disponibilité mixte : les articles peuvent être proposés en magasin et en ligne. Vérifier les conditions et la disponibilité de chaque référence.'
                                : 'Catalogue destiné aux magasins Lidl. Disponibilité selon les magasins participants et les stocks.'}
                            {' '}Les prix affichés ne constituent pas nécessairement des réductions par rapport à un ancien prix.
                          </p>
                        </div>
                      </details>
                    )
                  })}
                </>
              ) : !catalogLoading ? (
                <div className="feature-empty">
                  <div className="feature-icon products-icon">
                    <ShoppingBag size={27} />
                  </div>
                  <h2>Catalogue temporairement indisponible</h2>
                  <p>
                    Le catalogue sera affiché dès que l’API fournira une offre officielle
                    contenant ses articles détaillés.
                  </p>
                </div>
              ) : null}
            </div>
          )}
        </section>

        <main className="map-stage">
          {USE_MAPLIBRE ? (
            <Suspense
              fallback={(
                <div
                  className="maplibre-map"
                  role="status"
                  aria-live="polite"
                  style={{
                    width: '100%',
                    height: '100%',
                    minHeight: 420,
                    display: 'grid',
                    placeItems: 'center',
                    background: '#EAE7DE',
                  }}
                >
                  Chargement de la carte…
                </div>
              )}
            >
              <MapLibreView
                center={mapCenter}
                recenterRequest={mapRecenterRequest}
                places={selectedPlace ? [selectedPlace] : visiblePlaces}
                selectedId={selectedId}
                onSelect={selectPlace}
                fitPlaces={Boolean(query.trim() && visiblePlaces.length > 0)}
                routeCoordinates={routeCoordinates}
                showRoute={directionsOpen && routeCoordinates.length > 1}
                userPoint={userPoint}
                userHeading={userHeading}
              />
            </Suspense>
          ) : (
          <MapContainer
            center={[mapCenter.lat, mapCenter.lon]}
            zoom={13}
            scrollWheelZoom
            zoomSnap={0.5}
            zoomDelta={0.5}
            preferCanvas
            className="leaflet-map"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url={RASTER_TILE_URL}
              maxZoom={19}
            />
            <MapRecenter point={mapCenter} requestId={mapRecenterRequest} />
            {query.trim() && visiblePlaces.length > 0 && (
              <MapFitPlaces places={visiblePlaces} />
            )}
            {directionsOpen && routeCoordinates.length > 1 && (
              <>
                <MapFitRoute points={routeCoordinates} />
                <Polyline
                  positions={routeCoordinates}
                  pathOptions={{ color: '#49664e', weight: 6, opacity: 0.94 }}
                />
              </>
            )}

            {userPoint && (
              <>
                <Circle
                  center={[userPoint.lat, userPoint.lon]}
                  radius={55}
                  pathOptions={{
                    color: '#2563eb',
                    fillColor: '#60a5fa',
                    fillOpacity: 0.16,
                    weight: 1,
                  }}
                />
                <Marker
                  position={[userPoint.lat, userPoint.lon]}
                  icon={L.divIcon({
                    className: 'user-marker-shell',
                    html: `<div class="user-marker-wrap" style="--user-heading:${userHeading ?? 0}deg">
                      <span class="user-marker-pulse"></span>
                      <span class="user-marker-direction"></span>
                      <div class="user-marker">
                        <svg viewBox="0 0 40 40" aria-hidden="true">
                          <circle cx="20" cy="8" r="5" />
                          <path d="M13 17 Q20 13 27 17 L29 27 L25 27 L24 38 L19 38 L18 27 L15 38 L10 38 L13 23 L10 27 L7 25 Z" />
                        </svg>
                      </div>
                    </div>`,
                    iconSize: [56, 56],
                    iconAnchor: [28, 28],
                  })}
                  keyboard={false}
                />
              </>
            )}

            <MapPlaceLayer
              places={selectedPlace ? [selectedPlace] : visiblePlaces}
              selectedId={selectedId}
              onSelect={selectPlace}
            />
          </MapContainer>
          )}

          <div className="map-category-bar" aria-label="Catégories de commerces">
            {categories.filter((category) => category !== 'Tout').map((category) => (
              <button
                key={category}
                type="button"
                className={`map-category-chip ${activeCategory === category ? 'selected' : ''}`}
                onClick={() => {
                  setQuery('')
                  setActiveCategory(category)
                  setActiveSection('places')
                  void loadPlaces(userPoint || mapCenter, radius, '', category)
                }}
              >
                {category}
              </button>
            ))}
          </div>

          <div className="map-top-note">
            <span className="map-live-dot" />
            {searchMode === 'global'
              ? 'Recherche partout · données cartographiques disponibles'
              : 'Commerces et services autour de vous'}
          </div>


          {directionsOpen && selectedPlace &&
            destinationCompassBearing !== null &&
            destinationDistanceMeters !== null && (
              <div className="destination-compass" aria-live="polite">
                <div
                  className="destination-compass-dial"
                  role="img"
                  aria-label={`Direction vers ${selectedPlace.name}`}
                >
                  <span className="destination-compass-north">N</span>
                  <div
                    className="destination-compass-needle"
                    style={{ transform: `rotate(${destinationCompassRotation}deg)` }}
                  >
                    <Navigation size={25} strokeWidth={1.8} />
                  </div>
                  <span className="destination-compass-center" />
                </div>

                <div className="destination-compass-copy">
                  <span className="destination-compass-label">DESTINATION</span>
                  <strong title={selectedPlace.name}>{selectedPlace.name}</strong>
                  <span className="destination-compass-direct">
                    {formatCompassDistance(destinationDistanceMeters)} · direct
                  </span>
                  <span className="destination-compass-route">
                    {visibleRouteResult
                      ? `Trajet : ${visibleRouteResult.distanceKm.toFixed(1).replace('.', ',')} km`
                      : visibleRouteError
                        ? 'Distance du trajet indisponible'
                        : 'Calcul du trajet…'}
                  </span>
                  <span className="destination-compass-status">
                    {compassAccess === 'granted'
                      ? 'Compas du téléphone actif'
                      : userHeading !== null
                        ? 'Cap GPS · selon le déplacement'
                        : compassAccess === 'denied'
                          ? 'Orientation refusée · repère nord'
                          : 'Repère nord · orientation non détectée'}
                  </span>

                  {compassAccess !== 'granted' && (
                    <button
                      type="button"
                      className="destination-compass-enable"
                      onClick={() => {
                        const orientationApi =
                          DeviceOrientationEvent as typeof DeviceOrientationEvent & {
                            requestPermission?: () => Promise<'granted' | 'denied'>
                          }

                        if (typeof orientationApi.requestPermission !== 'function') return

                        void orientationApi.requestPermission()
                          .then((permission) => setCompassAccess(permission))
                          .catch(() => setCompassAccess('denied'))
                      }}
                    >
                      Activer le compas du téléphone
                    </button>
                  )}
                </div>
              </div>
            )}

          <div className="map-floating-controls">
            <button
              type="button"
              onClick={locateMe}
              title="Centrer sur ma position"
              aria-label="Centrer sur ma position"
            >
              <LocateFixed size={19} />
            </button>
            <button
              type="button"
              onClick={searchThisArea}
              title="Rechercher dans cette zone"
              aria-label="Rechercher dans cette zone"
              disabled={loading}
            >
              <Search size={19} />
            </button>
          </div>

          <div className="map-bottom-note">
            <span className="map-legend-marker" />
            Commerces disponibles via la source connectée
          </div>
        </main>

        {!directionsOpen && selectedPlace && (
          <aside className="detail-panel has-selection">
            {selectedPlace ? (
              <>
            <div
              className="detail-drag-handle"
              aria-label="Glisser vers le bas pour fermer la fiche"
              onTouchStart={(event) => {
                const touch = event.touches[0]
                if (touch) {
                  detailTouchStart.current = {
                    x: touch.clientX,
                    y: touch.clientY,
                  }
                }
              }}
              onTouchEnd={(event) => {
                const start = detailTouchStart.current
                detailTouchStart.current = null
                const touch = event.changedTouches[0]
                if (!start || !touch) return

                const dx = touch.clientX - start.x
                const dy = touch.clientY - start.y
                const isMobile = window.matchMedia('(max-width: 720px)').matches

                if (
                  (isMobile && dy > 65 && Math.abs(dy) > Math.abs(dx)) ||
                  (!isMobile && dx > 85 && Math.abs(dx) > Math.abs(dy))
                ) {
                  setSelectedId(null)
                }
              }}
              onTouchCancel={() => {
                detailTouchStart.current = null
              }}
            />
            <div className="detail-cover">
              {selectedPlace.image && safeUrl(selectedPlace.image) ? (
                <img src={safeUrl(selectedPlace.image)} alt="" />
              ) : (
                <div className="detail-cover-placeholder">
                  <Store size={35} />
                  <span>{selectedPlace.brand}</span>
                </div>
              )}
              <button
                className="detail-close"
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="Fermer la fiche"
              >
                <X size={18} />
              </button>
              <button
                className={`detail-favorite ${favorites.includes(selectedPlace.id) ? 'is-favorite' : ''}`}
                type="button"
                onClick={() => toggleFavorite(selectedPlace.id)}
                aria-label="Ajouter ou retirer des favoris"
              >
                <Heart
                  size={18}
                  fill={favorites.includes(selectedPlace.id) ? 'currentColor' : 'none'}
                />
              </button>
            </div>

            <div className="detail-content">
              <div className="detail-heading">
                <div className="eyebrow">CARNET D’ADRESSES</div>
                <h2>{selectedPlace.name}</h2>
                <div className="detail-category">{selectedPlace.category}</div>
              </div>

              <div className="detail-facts">
                <div className="fact-row">
                  <Navigation size={17} />
                  <span>{selectedPlace.address}</span>
                </div>
                {selectedPlace.distance !== null && (
                  <div className="fact-row">
                    <Compass size={17} />
                    <span>{formatDistance(selectedPlace.distance)} de votre position de recherche</span>
                  </div>
                )}
                {selectedPlace.openingHours && (
                  <div className="fact-row">
                    <Clock3 size={17} />
                    <span>{selectedPlace.openingHours}</span>
                  </div>
                )}
                {selectedPhone && (
                  <a className="fact-row fact-link" href={`tel:${selectedPhone}`}>
                    <Phone size={17} />
                    <span>{selectedPhone}</span>
                  </a>
                )}
                {selectedWebsite && (
                  <a
                    className="fact-row fact-link"
                    href={selectedWebsite}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Globe2 size={17} />
                    <span>Site internet</span>
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>

              <button
                className="directions-button"
                type="button"
                onClick={openDirections}
              >
                <Navigation size={17} />
                Itinéraire
                <ChevronRight size={16} />
              </button>

              <div className="offers-heading">
                <div>
                  <div className="eyebrow">ÉCONOMIES</div>
                  <h3>Offres et promotions</h3>
                </div>
                {offerCount > 0 && (
                  <span className="offer-count">{offerCount}</span>
                )}
              </div>

              {offersLoading ? (
                <div className="offers-loading">
                  <span className="spinner" />
                  Vérification des offres…
                </div>
              ) : offerCount === 0 ? (
                <div className="no-offers">
                  <div className="no-offers-icon">
                    <Tag size={20} />
                  </div>
                  <strong>Aucune offre vérifiée disponible</strong>
                  <p>
                    Aucune promotion vérifiée n’est actuellement rattachée à ce
                    commerce dans la base connectée.
                  </p>
                </div>
              ) : (
                <div className="offer-groups">
                  {offerGroups
                    .filter((group) => group.items.length > 0)
                    .map((group) => (
                      <section className="offer-group" key={group.key}>
                        <div className="offer-group-title">{group.title}</div>
                        <p>{group.description}</p>
                        {group.items.map((offer, index) => {
                          const link = safeUrl(
                            offer.landingUrl ||
                            offer.landing_url ||
                            offer.sourceUrl ||
                            offer.source_url ||
                            '',
                          )
                          const discount = offer.discountLabel || offer.discount_label
                          const promoCode = offer.promoCode || offer.promo_code
                          const sourceName = offer.sourceName || offer.source_name || 'Source officielle'
                          const validity = formatOfferValidity(
                            offer.validFrom || offer.valid_from,
                            offer.validUntil || offer.valid_until,
                          )

                          return (
                            <article
                              className="offer-card"
                              key={offer.id || `${group.key}-${index}`}
                            >
                              {discount ? (
                                <span className="discount-label">{discount}</span>
                              ) : null}
                              <strong>{offer.title || 'Promotion'}</strong>
                              {offer.description && <p>{offer.description}</p>}
                              <CatalogItemList items={offer.catalogItems} />
                              {offer.terms && (
                                <p className="offer-terms">Conditions : {offer.terms}</p>
                              )}
                              {promoCode && (
                                <div className="promo-code">
                                  Code : <b>{promoCode}</b>
                                </div>
                              )}
                              <div className="offer-card-foot">
                                <span>{validity || 'Offre vérifiée'} · {sourceName}</span>
                                {link && (
                                  <a href={link} target="_blank" rel="noreferrer">
                                    Voir l’offre <ArrowUpRight size={13} />
                                  </a>
                                )}
                              </div>
                            </article>
                          )
                        })}
                      </section>
                    ))}
                </div>
              )}
            </div>
              </>
            ) : (
              <div className="detail-empty-state">
                <div className="detail-empty-icon">
                  <Store size={32} />
                </div>
                <div className="eyebrow">VOTRE SÉLECTION</div>
                <h2>Votre fiche commerce</h2>
                <p>
                  Sélectionnez un commerce dans les résultats.
                  Sa fiche, ses informations pratiques et ses promotions
                  apparaîtront ici sans masquer votre liste.
                </p>
                <div className="detail-empty-tip">
                  <Tag size={16} />
                  <span>Commerces, produits et bonnes affaires au même endroit.</span>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      <footer className="app-footer">
        <span>
          <span className="footer-dot" />
          MapNifique V2
        </span>
        <span>Données commerces fournies par la source connectée · © OpenStreetMap</span>
      </footer>
    </div>
  )
}

export default App
