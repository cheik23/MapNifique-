import './style.css';

// html5-qrcode for barcode scanning
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
// db module for IndexedDB operations
import { openDB, dbGet, dbSet, dbDelete, dbClear, dbAll } from "./db";
// Calcul d'itineraires multimodaux (Navitia, avec repli de demonstration)
import { getJourneys, MODE_META } from './services/route-service.js';
// Cache persistant des reponses API (respect des quotas gratuits)
import { cachedJson, buildCacheKey, DEFAULT_TTL_MS as API_CACHE_TTL_MS } from './api-manager.js';

// Enregistrement du Service Worker (mode hors-ligne / PWA - Section 7)
// En PRODUCTION uniquement : en développement, un SW en cache-first sert
// l'ancien code et masque toutes les modifications.
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      // Chemin relatif : fonctionne à la racine comme dans un sous-dossier (GitHub Pages)
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => console.info('[SW] Enregistré, portée :', reg.scope))
        .catch((err) => console.error('[SW] Échec d\'enregistrement :', err));
    });
  } else {
    // Développement : on désenregistre un SW éventuellement déjà installé et on
    // purge ses caches, sinon l'ancienne version continue d'être servie.
    navigator.serviceWorker.getRegistrations()
      .then((regs) => {
        regs.forEach((reg) => reg.unregister());
        if (regs.length) console.info('[SW] Désenregistré en développement :', regs.length);
      })
      .catch((err) => console.warn('[SW] Désenregistrement impossible :', err));

    if ('caches' in window) {
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .then((res) => {
          if (res.length) console.info('[SW] Caches purgés en développement :', res.length);
        })
        .catch((err) => console.warn('[SW] Purge des caches impossible :', err));
    }
  }
}

// Constant for Amazon Associates affiliate tag
// TODO: Remplacer par ton vrai tag Amazon Partenaires
const AMAZON_TAG = "TON_TAG_ICI";

// ---------------------------------------------------------------------------
// Awin — réseau d'affiliation (Link Builder)
// Le token n'est PAS dans le bundle : il vit dans la variable d'environnement
// Vercel AWIN_API_TOKEN, lue par la fonction serverless api/awin.js.
// REMPLACER la valeur ci-dessous par votre identifiant éditeur Awin (numérique).
// ---------------------------------------------------------------------------
const AWIN_PUBLISHER_ID = 'TON_PUBLISHER_ID';
// Proxy même origine : fonction serverless Vercel (api/awin.js).
const AWIN_PROXY_URL = '/api/awin';
// ID annonceur du produit « en ligne » du comparateur (démo) : à remplacer
// par l'ID réel du programme annonceur, par exemple 12345.
const AWIN_ADVERTISER_EXAMPLE_ID = 'TON_ADVERTISER_ID';
// Limite Awin : 20 appels par minute, soit au moins 3 s entre deux appels.
const AWIN_MIN_INTERVAL_MS = Math.ceil(60000 / 20);

// Vrai uniquement quand l'identifiant éditeur a été remplacé.
const AWIN_CONFIGURED = !AWIN_PUBLISHER_ID.startsWith('TON_');

const awinLinkCache = new Map();
let awinLastRequestAt = 0;
let awinChain = Promise.resolve();

// Sérialise les appels Awin pour ne jamais dépasser 20 requêtes par minute.
const scheduleAwinRequest = (task) => {
  const run = awinChain.then(async () => {
    const wait = AWIN_MIN_INTERVAL_MS - (Date.now() - awinLastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    awinLastRequestAt = Date.now();
    return task();
  });
  // La chaîne ne doit jamais rester rejetée, sinon les appels suivants sautent.
  awinChain = run.catch(() => {});
  return run;
};

// Échappe une valeur destinée à un attribut HTML.
const escapeHtmlAttr = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * Génère un lien de suivi Awin via le Link Builder.
 * @param {string|number} advertiserId ID du programme annonceur Awin
 * @param {string} destinationUrl URL finale du produit
 * @returns {Promise<string|null>} URL de suivi, ou null si non configuré / en échec
 */
const generateAwinLink = async (advertiserId, destinationUrl) => {
  if (!AWIN_CONFIGURED) return null;
  if (!advertiserId || String(advertiserId).startsWith('TON_')) return null;
  if (!destinationUrl) return null;

  const cacheKey = `${advertiserId}|${destinationUrl}`;
  const cachedLink = awinLinkCache.get(cacheKey);
  if (cachedLink) return cachedLink;

  try {
    // Appel au proxy serverless : le token ne quitte jamais le serveur.
    const data = await scheduleAwinRequest(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(AWIN_PROXY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publisherId: AWIN_PUBLISHER_ID,
            advertiserId,
            destinationUrl,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
        }

        return await response.json();
      } finally {
        clearTimeout(timeoutId);
      }
    });

    // Le proxy renvoie { url } ou { error }.
    const trackingUrl = (typeof data === 'string' ? data : null) || data?.url || null;
    if (!trackingUrl) throw new Error(data?.error || 'réponse sans URL de suivi');

    awinLinkCache.set(cacheKey, trackingUrl);
    return trackingUrl;
  } catch (error) {
    console.warn('[Awin] Génération du lien impossible :', error?.message || error);
    return null;
  }
};

/**
 * Remplace, après affichage, les liens de secours par les liens de suivi Awin.
 * N'attend jamais l'API pour rendre la liste ; en cas d'échec, un message
 * discret est ajouté sous l'offre concernée.
 */
const hydrateAwinLinks = async (root) => {
  if (!AWIN_CONFIGURED || !root) return;

  const anchors = Array.from(root.querySelectorAll('a[data-awin-advertiser]'));
  for (const anchor of anchors) {
    const advertiserId = anchor.dataset.awinAdvertiser;
    const destinationUrl = anchor.dataset.awinDestination;
    if (!advertiserId || advertiserId.startsWith('TON_')) continue;

    const trackingUrl = await generateAwinLink(advertiserId, destinationUrl);
    if (trackingUrl) {
      anchor.href = trackingUrl;
      anchor.dataset.awinStatus = 'ok';
      continue;
    }

    anchor.dataset.awinStatus = 'fallback';
    const card = anchor.closest('[data-offer-card]');
    if (card && !card.querySelector('[data-awin-note]')) {
      const note = document.createElement('p');
      note.setAttribute('data-awin-note', '');
      note.style.cssText = 'margin: 6px 0 0; font-size: 11px; color: #9e9e9e;';
      note.textContent = 'Lien partenaire momentanément indisponible — lien de secours utilisé.';
      card.appendChild(note);
    }
  }
};

// Check if a cached search exists (same query, ~1km radius, <24h old)
// Returns cached results or null
const checkCache = async (query, lat, lon) => {
  try {
    // Use db module instead of direct IndexedDB
    const cached = await dbGet('recherches', query.toLowerCase());
    if (cached) {
      // Verify entry is < 24 hours old
      const now = Date.now();
      const twentyFourHours = 24 * 60 * 60 * 1000;
      if (now - cached.timestamp > twentyFourHours) {
        // Old entry - skip
        return null;
      }
      return cached;
    }
    return null;
  } catch (error) {
    console.error('Cache check error:', error);
    return null;
  }
};

// Store search result in IndexedDB
const storeInCache = async (query, lat, lon, results) => {
  try {
    // Use db module instead of direct IndexedDB
    const now = Date.now();
    const cached = await dbGet('recherches', query.toLowerCase());
    
    if (cached) {
      // Update existing entry
      cached.timestamp = now;
      cached.results = results;
      await dbSet('recherches', cached.id, cached);
    } else {
      // Store new entry
      const dataToStore = {
        query: query.trim().toLowerCase(),
        lat: lat.toFixed(6),
        lon: lon.toFixed(6),
        timestamp: now,
        results: results
      };
      await dbSet('recherches', query.toLowerCase(), dataToStore);
    }
  } catch (error) {
    console.error('Cache store error:', error);
  }
};

// Store product in IndexedDB cache
const storeProductInCache = async (code, productData) => {
  try {
    // Use db module instead of direct IndexedDB
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    
    // Check if product already exists in cache
    const existing = await dbGet('produits', code);
    if (existing) {
      // Update existing product
      await dbSet('produits', code, {...existing, timestamp: now, ...productData});
    } else {
      // Store new product
      const dataToStore = {
        code: code.toLowerCase(),
        timestamp: now,
        ...productData
      };
      await dbSet('produits', code, dataToStore);
    }
  } catch (error) {
    console.error('Product cache store error:', error);
  }
};

// Check if product exists in cache (same code, <7 days old)
// Returns cached product data or null
const checkProductInCache = async (code) => {
  try {
    // Use db module instead of direct IndexedDB
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    
    const existing = await dbGet('produits', code);
    if (existing) {
      // Check if entry is < 7 days old
      if (now - existing.timestamp > sevenDays) {
        // Old entry - remove and return null
        await dbDelete('produits', code);
        return null;
      }
      return existing;
    }
    return null;
  } catch (error) {
    console.error('Product cache check error:', error);
    return null;
  }
};

// Remove product from IndexedDB cache
function removeProductFromCache(code) {
  const request = indexedDB.open('MonApp', 1);
  request.onsuccess = (event) => {
    const db = event.target.result;
    const transaction = db.transaction(['produits'], 'readwrite');
    const store = transaction.objectStore('produits');
    const queryReq = store.delete(code.trim());

    queryReq.onsuccess = () => {
      console.log('Produit supprimé du cache:', code);
    };

    queryReq.onerror = (err) => {
      console.error('Product cache remove error:', err);
    };
  };
  request.onerror = (err) => {
    console.error('Erreur IndexedDB:', err);
  };
};

// Toast notification system
let toastTimeouts = {};

const showToast = (message, variant = 'info') => {
  let container = document.getElementById('toast-container');
  if (!container) {
    const newContainer = document.createElement('div');
    newContainer.id = 'toast-container';
    newContainer.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;
    document.body.appendChild(newContainer);
    // Sans cette réaffectation, container restait null et tout showToast
    // levait « Cannot read properties of null (reading 'appendChild') ».
    container = newContainer;
  }

  const toast = document.createElement('div');
  toast.style.cssText = `
    background: white;
    border-left: 4px solid;
    padding: 12px 16px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-size: 14px;
    min-width: 280px;
    max-width: 300px;
    word-wrap: break-word;
    z-index: 1001;
  `;

  // Set color based on variant
  const variantStyles = {
    info: { 'border-left-color': '#1976d2', 'background': '#E3F2FD' },
    success: { 'border-left-color': '#4caf50', 'background': '#E8F5E0' },
    error: { 'border-left-color': '#f44336', 'background': '#FFEBEE' },
    warning: { 'border-left-color': '#ff9800', 'background': '#FFF3E0' }
  };

  const styles = variantStyles[variant] || variantStyles.info;
  Object.assign(toast.style, styles);

  toast.textContent = message;
  container.appendChild(toast);

  // Auto-remove after 4 seconds
  const timeout = setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
    clearTimeout(toastTimeouts[message]);
    delete toastTimeouts[message];
  }, 4000);

  toastTimeouts[message] = timeout;
}

// Text-to-Speech state
let voiceEnabled = false;
let voiceSynthesisSupported = false;

// Check if speech synthesis is supported and read initial state
const initTextToSpeech = () => {
  const supportsSynth = 'speechSynthesis' in window;
  voiceSynthesisSupported = supportsSynth;
  
  // Read saved state from localStorage
  const savedState = localStorage.getItem('voiceEnabled');
  if (savedState !== null) {
    voiceEnabled = savedState === 'true';
  }
  
  updateVoiceButtonState();
};

// Update the voice toggle button appearance
const updateVoiceButtonState = () => {
  const voiceBtn = document.getElementById('voice-toggle-btn');
  if (!voiceBtn) return;
  
  if (voiceEnabled && voiceSynthesisSupported) {
    voiceBtn.style.borderLeftColor = '#4caf50';
    voiceBtn.setAttribute('aria-pressed', 'true');
  } else {
    voiceBtn.style.borderLeftColor = '#e5e4e7';
    voiceBtn.setAttribute('aria-pressed', 'false');
  }
};

// Text-to-Speech utterance - cancels any ongoing speech before speaking
const speakText = (text) => {
  if (!voiceEnabled || !voiceSynthesisSupported) return;
  
  // Cancel any ongoing speech first
  window.speechSynthesis.cancel();
  
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'fr-FR';
  utterance.rate = 1; // normal rate
  utterance.volume = 1; // max volume
  utterance.pitch = 1; // normal pitch
  
  window.speechSynthesis.speak(utterance);
};

// Read product info aloud: "[Nom du produit]. Nutri-Score [X]. [N] additifs détectés."
const lireFiche = (produit) => {
  if (!voiceEnabled || !voiceSynthesisSupported) return;
  
  // Cancel any ongoing speech
  window.speechSynthesis.cancel();
  
  // Format the text: "[Nom du produit]. Nutri-Score [X]. [N] additifs détectés."
  const nbAdditifs = produit.additifs ? produit.additifs.length : 0;
  const text = `${produit.nom}. Nutri-Score ${produit.nutriscore || '?'} . ${nbAdditifs} additifs détectés.`;
  
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'fr-FR';
  utterance.rate = 1; // normal rate
  utterance.volume = 1; // max volume
  utterance.pitch = 1; // normal pitch
  
  window.speechSynthesis.speak(utterance);
};

// Read best comparison result aloud: "Le meilleur choix est [produit] à [prix] euros chez [magasin], à [distance] de toi. Tu économises [montant] euros."
const lireComparateur = (resultats) => {
  if (!voiceEnabled || !voiceSynthesisSupported) return;
  
  // Cancel any ongoing speech
  window.speechSynthesis.cancel();
  
  // Find the best result (first one or the one with lowest price)
  const meilleurResultat = resultats && resultats.length > 0 ? resultats[0] : null;
  if (!meilleurResultat) return;
  
  // Format the price and savings (use defaults if not available)
  const prix = meilleurResultat.prix !== undefined ? meilleurResultat.prix : '?';
  const magasin = meilleurResultat.magasin || 'inconnu';
  const distance = meilleurResultat.distance !== undefined ? `${meilleurResultat.distance.toFixed(1)}` : '?';
  const montantEconomise = meilleurResultat.montantEconomise !== undefined ? `${meilleurResultat.montantEconomise.toFixed(2)}` : '?';
  
  // Format the text: "Le meilleur choix est [produit] à [prix] euros chez [magasin], à [distance] de toi. Tu économises [montant] euros."
  const text = `Le meilleur choix est ${meilleurResultat.nom} à ${prix} euros chez ${magasin}, à ${distance} de toi. Tu économise ${montantEconomise} euros.`;
  
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'fr-FR';
  utterance.rate = 1; // normal rate
  utterance.volume = 1; // max volume
  utterance.pitch = 1; // normal pitch
  
  window.speechSynthesis.speak(utterance);
};

// Expose la fonction pour les attributs onclick générés dynamiquement
window.lireComparateur = lireComparateur;

// Global app state (shared between views)
let map = null;
let recognition = null;
let isListening = false;
let searchMarkers = [];
let microphoneContainer = null;
let microphoneBtn = null;
let speechBubble = null;
let pulseIcon = null;
const domElements = {};

// Remove all search markers
function removeSearchMarkers() {
  if (!map) return;
  searchMarkers.forEach(marker => map.removeLayer(marker));
  searchMarkers = [];
}

// ---------------------------------------------------------------------------
// Localisation : GPS navigateur → repli par IP → centre de Paris
// Sur PC, la géolocalisation native échoue souvent (absence de GPS, permission
// refusée, timeout) : on garantit toujours une position exploitable.
// ---------------------------------------------------------------------------
const PARIS_FALLBACK = { lat: 48.8566, lon: 2.3522, city: 'Paris' };
const GEOLOCATION_TIMEOUT_MS = 3000;
const IP_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Position approximative déduite de l'adresse IP (aucune clé requise).
 * @returns {Promise<{lat: number, lon: number, city: string}>}
 */
const getFallbackLocation = async () => {
  const providers = [
    {
      url: 'https://ipwho.is/',
      read: (data) => (data && data.success !== false && Number.isFinite(Number(data.latitude))
        ? { lat: Number(data.latitude), lon: Number(data.longitude), city: data.city || '' }
        : null),
    },
    {
      url: 'https://ipapi.co/json/',
      read: (data) => (data && Number.isFinite(Number(data.latitude))
        ? { lat: Number(data.latitude), lon: Number(data.longitude), city: data.city || '' }
        : null),
    },
  ];

  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, { signal: AbortSignal.timeout(IP_LOOKUP_TIMEOUT_MS) });
      if (!response.ok) continue;
      const location = provider.read(await response.json());
      if (location) return location;
    } catch (error) {
      console.warn('[Localisation] Repli IP indisponible :', provider.url, error?.message || error);
    }
  }

  // Dernier recours : centre de Paris.
  return { ...PARIS_FALLBACK };
};

/**
 * Position utilisable par l'app : navigateur (3 s) puis repli IP.
 * @returns {Promise<{lat: number, lon: number, city: string, approximate: boolean}>}
 */
const resolveLocation = async () => {
  const precise = await new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);

    // Le "timeout" de l'API géolocalisation ne démarre qu'une fois la
    // permission accordée : si l'utilisateur ne répond jamais à la demande,
    // aucun callback n'arrive et la promesse resterait pendante. Ce minuteur
    // dur garantit qu'on retombe toujours sur le repli.
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => finish(null), GEOLOCATION_TIMEOUT_MS + 500);

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => finish({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          city: '',
        }),
        () => finish(null),
        { enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 300000 }
      );
    } catch (error) {
      console.warn('[Localisation] Géolocalisation indisponible :', error?.message || error);
      finish(null);
    }
  });

  if (precise) return { ...precise, approximate: false };

  const fallback = await getFallbackLocation();
  return { ...fallback, approximate: true };
};

// Pulse animation style injection for the microphone button
const addPulseAnimation = () => {
  if (document.getElementById('mic-pulse-style')) return;
  const style = document.createElement('style');
  style.id = 'mic-pulse-style';
  style.textContent = `
    @keyframes micPulse {
      0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(25, 118, 210, 0.4); }
      70% { transform: scale(1.08); box-shadow: 0 0 0 12px rgba(25, 118, 210, 0); }
      100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(25, 118, 210, 0); }
    }
  `;
  document.head.appendChild(style);
};

// Speech recognition (recherche vocale) : remplit la barre de recherche et lance la recherche
const initSpeechRecognition = () => {
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionImpl) {
    console.info('Reconnaissance vocale non supportée par ce navigateur.');
    const micContainerEl = document.getElementById('microphone-container');
    if (micContainerEl) micContainerEl.style.display = 'none';
    return;
  }

  recognition = new SpeechRecognitionImpl();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'fr-FR';

  recognition.onstart = () => {
    isListening = true;
    if (microphoneBtn) {
      microphoneBtn.style.background = '#1976d2';
      microphoneBtn.style.animation = 'micPulse 1.6s infinite';
    }
    if (speechBubble) {
      speechBubble.textContent = 'Écoute...';
      speechBubble.style.opacity = 1;
    }
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    if (speechBubble) {
      speechBubble.textContent = transcript;
      speechBubble.style.opacity = 1;
    }
    const last = event.results[event.results.length - 1];
    if (last.isFinal && transcript.trim()) {
      const searchInput = document.getElementById('search-input');
      const searchBtn = document.getElementById('search-btn');
      if (searchInput && searchBtn) {
        searchInput.value = transcript.trim();
        searchBtn.click();
      }
    }
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    isListening = false;
    if (microphoneBtn) {
      microphoneBtn.style.background = 'white';
      microphoneBtn.style.animation = 'none';
    }
  };

  recognition.onend = () => {
    isListening = false;
    if (microphoneBtn) {
      microphoneBtn.style.background = 'white';
      microphoneBtn.style.animation = 'none';
    }
    if (pulseIcon) pulseIcon.style.animation = 'none';
  };
};

// Initialize IndexedDB and cache badge
const initIndexedDB = async () => {
  try {
    await openDB();
  } catch (e) {
    console.error('IndexedDB initialization failed:', e);
  }
}

// Main initialization
document.addEventListener('DOMContentLoaded', () => {
  const mapContainer = document.getElementById('map');

  // Create map when the Carte view is shown (single safe initialization path)
  window.initializeMap = function() {
    if (map) return; // Already initialized

    const tryInit = () => {
      if (map) { clearInterval(checkInterval); return; } // guard against double init
      const mapStyle = window.getComputedStyle(mapContainer);
      if (mapStyle.display !== 'none' && mapContainer.offsetWidth > 0 && mapContainer.offsetHeight > 0) {
        clearInterval(checkInterval);

        map = L.map('map').setView([46.2276, 2.2137], 6);
        // Fond raster OSM France : gratuit, sans cle API ni plugin.
        L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
          subdomains: 'abc',
          maxZoom: 20,
          attribution: '&copy; OpenStreetMap contributors - rendu OSM France',
        }).addTo(map);
        L.marker([46.2276, 2.2137]).addTo(map)
          .bindPopup('France')
          .openPopup();
        map.invalidateSize();
        setTimeout(() => { if (map) map.invalidateSize(); }, 200);
      }
    };

    const checkInterval = setInterval(tryInit, 100);
    tryInit(); // premier essai immédiat
  };

  // Create "Ma position" button
  const positionBtn = document.createElement('button');
  positionBtn.id = 'position-btn';
  positionBtn.innerHTML = 'Ma position';
  positionBtn.style.margin = '10px';
  positionBtn.style.padding = '8px 16px';
  positionBtn.style.fontSize = '14px';
  positionBtn.style.cursor = 'pointer';

  // Le bouton « Ma position » doit vivre dans la vue Carte : ce projet n'a pas de #app
  const appElement = document.querySelector('#app')
    || document.getElementById('view-carte')
    || document.getElementById('views');

  // Offline banner elements
  const offlineBanner = document.getElementById('offline-banner');
  const offlineCloseBtn = document.getElementById('offline-close-btn');
  const installBtn = document.getElementById('install-btn');
  const installedMsg = document.getElementById('installed-msg');

  // Handle offline banner close button
  if (offlineCloseBtn) {
    offlineCloseBtn.addEventListener('click', () => {
      offlineBanner.style.display = 'none';
    });
  }

  // Handle install button
  let deferredPrompt;
  const beforeinstallpromptEvent = () => {
    deferredPrompt = event;
    if (installBtn) {
      installBtn.style.display = 'block';
    }
  };

  window.addEventListener('beforeinstallprompt', beforeinstallpromptEvent);

  // Check if already installed via display-mode
  const checkInstallStatus = () => {
    if (window.matchMedia('(display-mode: standalone)').matches) {
      // App is in standalone mode, already installed
      if (installBtn) {
        installBtn.style.display = 'none';
      }
      if (installedMsg) {
        installedMsg.style.display = 'block';
      }
    }
  };

  // Run on load and on display-mode change
  checkInstallStatus();
  window.matchMedia('(display-mode: standalone)').addListener(checkInstallStatus);

  // Handle install button click
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        // Wait for the user to respond to the prompt
        deferredPrompt.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            // App installed successfully
            if (installBtn) {
              installBtn.style.display = 'none';
            }
            if (installedMsg) {
              installedMsg.style.display = 'block';
            }
          }
          deferredPrompt = null;
        });
      }
    });
  }

  // Handle download zone button
  const downloadZoneBtn = document.getElementById('download-zone-btn');
  if (downloadZoneBtn) {
    downloadZoneBtn.addEventListener('click', async () => {
      // Get current position from map
      const center = map.getCenter();
      const lat = center.lat;
      const lon = center.lng;

      // Show loading state
      downloadZoneBtn.disabled = true;
      downloadZoneBtn.innerHTML = 'En cours...';
      showToast('Téléchargement de la zone en cours...', 'info');

      // Send message to service worker to cache tiles
      if (navigator.serviceWorker.controller) {
        try {
          const port = new MessageChannel();
          port.port1.onmessage = (e) => {
            if (e.data && e.data.type === 'tiles-cached') {
              downloadZoneBtn.disabled = false;
              downloadZoneBtn.innerHTML = '✅ Zone mise en cache';
              showToast('Zone de 5 km téléchargée (' + e.data.count + ' tuiles).', 'success');
              setTimeout(() => {
                downloadZoneBtn.innerHTML = '📥 Télécharger la zone (5km)';
              }, 2500);
            }
          };
          navigator.serviceWorker.controller.postMessage(
            { type: 'CACHE_ZONE', lat, lng: lon, radius: 5 },
            [port.port2]
          );
        } catch (e) {
          console.error('[Main] Error contacting SW:', e);
          showToast('Service Worker indisponible.', 'error');
        }
      } else {
        showToast('Service Worker non actif — rechargez la page.', 'error');
        downloadZoneBtn.disabled = false;
        downloadZoneBtn.innerHTML = '📥 Télécharger la zone (5km)';
      }
    });
  }

  // Listen for online/offline messages from SW
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type) {
      if (event.data.type === 'go-offline') {
        if (offlineBanner) {
          offlineBanner.style.display = 'flex';
          offlineBanner.style.flexDirection = 'column';
          offlineBanner.style.alignItems = 'center';
        }
      } else if (event.data.type === 'hide-offline-banner') {
        if (offlineBanner) {
          offlineBanner.style.display = 'none';
        }
      }
      if (event.data.type === 'tiles-cached') {
        // Show success message
        if (downloadZoneBtn) {
          downloadZoneBtn.disabled = false;
          downloadZoneBtn.innerHTML = '✅ Zone mise en cache';
          setTimeout(() => {
            downloadZoneBtn.disabled = false;
            downloadZoneBtn.innerHTML = '📥 Télécharger la zone';
          }, 2000);
        }
      }
    }
  });

  // Listen for online/offline events
  window.addEventListener('online', () => {
    if (offlineBanner) {
      offlineBanner.style.display = 'none';
    }
  });

  window.addEventListener('offline', () => {
    if (offlineBanner) {
      offlineBanner.style.display = 'flex';
    }
  });

  // État initial : si la page démarre hors-ligne, afficher immédiatement le bandeau
  if (!navigator.onLine && offlineBanner) {
    offlineBanner.style.display = 'flex';
  }
  if (appElement) {
    appElement.insertBefore(positionBtn, appElement.firstElementChild);
  }

  // Position button at top-right of map using CSS
  const style = document.createElement('style');
  style.textContent = `
    #position-btn {
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 1000;
      background: white;
      border: 2px solid #ccc;
      border-radius: 4px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    }
    #position-btn:hover {
      border-color: #888;
    }
    #position-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    #map {
      position: relative;
      width: 100%;
      height: 100%;
    }
    #views {
      height: calc(100vh - 164px);
    }
  `;
  document.head.appendChild(style);

  // Add loading state function for position button
  function setButtonLoading(isLoading) {
    if (isLoading) {
      positionBtn.innerHTML = 'Localisation...';
      positionBtn.disabled = true;
    } else {
      positionBtn.innerHTML = 'Ma position';
      positionBtn.disabled = false;
    }
  }

  // Handle position button click — GPS (3 s), puis repli par IP, puis Paris.
  positionBtn.addEventListener('click', async () => {
    setButtonLoading(true);

    const location = await resolveLocation();
    if (!map) {
      setButtonLoading(false);
      return;
    }

    // Zoom plus large quand la position est approximative.
    map.setView([location.lat, location.lon], location.approximate ? 12 : 15);

    if (window.currentMarker) {
      map.removeLayer(window.currentMarker);
    }

    // Marqueur bleu = GPS précis, orange = position approximative (IP).
    window.currentMarker = L.circleMarker([location.lat, location.lon], {
      radius: 12,
      fillColor: location.approximate ? '#f9a825' : '#3b82f6',
      color: '#ffffff',
      weight: 2,
      fillOpacity: 0.8,
    }).addTo(map);

    if (location.approximate) {
      showToast('Localisation approximative utilisée (via IP)', 'warning');
    }

    setButtonLoading(false);
  });

  // Search state
  let isSearching = false;
  let latestSearchId = 0; // Jeton : seule la dernière recherche écrit à l'écran
  let currentFilter = null; // Track current filter (e.g., "shop=supermarket")

  // Default bounding box for France (or use user's location area)
  const defaultViewbox = '2.3522,51.0994,9.5162,41.3568'; // roughly France's bbox: minLon, minLat, maxLon, maxLat

  // DOM elements
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const searchBtn = document.getElementById('search-btn');
  const voiceToggleBtn = document.getElementById('voice-toggle-btn');

  // -------------------------------------------------------------------------
  // Recherche par catégorie (tags OSM via Overpass)
  // Chaque bouton de #filter-bar porte data-category="clé=valeur", par ex.
  // "amenity=restaurant". Un clic lance performSearch() avec ce tag.
  // -------------------------------------------------------------------------
  // Instances Overpass essayées dans l'ordre : l'officielle est souvent saturée.
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const SEARCH_RADIUS_M = 2000;
  // Overpass reste la source des recherches par tag, mais les instances
  // publiques sont souvent saturees : Nominatim sert de source principale
  // pour les recherches par nom et de repli pour les categories.
  const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  const OVERPASS_TIMEOUT_MS = 4000;
  const NOMINATIM_TIMEOUT_MS = 8000;

  // Distance en metres entre deux points { lat, lon | lng } (equirectangulaire).
  const distanceMeters = (from, to) => {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const lat1 = from.lat;
    const lon1 = from.lng ?? from.lon;
    const lat2 = to.lat;
    const lon2 = to.lng ?? to.lon;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };

  // Convertit une reponse Overpass en liste de lieux exploitables.
  const placesFromOverpass = (data) => (data.elements || [])
    .map((el) => {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) return null;
      return { lat, lon, tags: el.tags || {} };
    })
    .filter(Boolean);

  // Overpass : essaie chaque miroir dans l'ordre, avec un timeout par essai.
  const searchOverpass = async (center, tag, textQuery) => {
    const body = new URLSearchParams({ data: buildOverpassQuery(center, tag, textQuery) });
    let lastError = null;

    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body,
          // Sans timeout, un miroir muet bloquerait la recherche indefiniment.
          signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return placesFromOverpass(await response.json());
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('aucune instance Overpass disponible');
  };

  // Nominatim : CORS ouvert, repond vite. La recherche est bornee a une
  // boite englobante autour du centre pour rester locale.
  const searchNominatim = async (center, query) => {
    const d = 0.06; // ~6 km autour du centre
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: query,
      limit: '40',
      dedupe: '1',
      addressdetails: '1',
      'accept-language': 'fr',
      viewbox: `${center.lng - d},${center.lat + d},${center.lng + d},${center.lat - d}`,
    });
    const url = `${NOMINATIM_ENDPOINT}?${params}`;
    // Cache 24 h : une meme recherche ne repart pas vers Nominatim.
    const { data } = await cachedJson(buildCacheKey('nominatim:search', [url]), url, {
      ttlMs: API_CACHE_TTL_MS,
      init: {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      },
    });

    const rows = data;
    return (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const lat = Number(row.lat);
        const lon = Number(row.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          lat,
          lon,
          tags: {
            name: row.name || (row.display_name || '').split(',')[0],
            'addr:housenumber': row.address?.house_number,
            'addr:street': row.address?.road,
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => distanceMeters(center, a) - distanceMeters(center, b));
  };

  // Choisit la source : nom -> Nominatim d'abord, categorie -> Overpass d'abord.
  const fetchPlaces = async (center, tag, textQuery, label) => {
    const query = textQuery
      || label
      || String(tag || '').split('=')[1]?.replace(/_/g, ' ')
      || '';

    if (!tag) {
      try {
        const places = await searchNominatim(center, query);
        if (places.length) return places;
      } catch (error) {
        console.warn('[Recherche] Nominatim indisponible :', error);
      }
      // Aucun resultat ou service indisponible : on tente Overpass par nom.
      return searchOverpass(center, null, query);
    }

    try {
      return await searchOverpass(center, tag, textQuery);
    } catch (error) {
      console.warn('[Recherche] Overpass indisponible, repli Nominatim :', error);
      return searchNominatim(center, query);
    }
  };

  const filterButtons = Array.from(document.querySelectorAll('.filter-btn'));
  const clearFilterBtn = document.getElementById('clear-filter-btn');

  // Met en évidence la catégorie active (et met à jour l'état a11y).
  const setActiveFilterButton = (activeTag) => {
    filterButtons.forEach((btn) => {
      const isActive = activeTag !== null && btn.dataset.category === activeTag;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  };

  // Centre de recherche : GPS navigateur (3 s) → repli par IP → centre carte.
  // Aucune recherche ne doit échouer faute de position disponible.
  const getSearchCenter = async () => {
    const location = await resolveLocation();
    if (!location) return map ? map.getCenter() : null;

    if (location.approximate) {
      showToast('Localisation approximative utilisée (via IP)', 'warning');
    }

    return L.latLng(location.lat, location.lon);
  };

  // Construit la requête Overpass : par tag OSM, sinon par nom.
  const buildOverpassQuery = (center, osmTag, textQuery) => {
    const around = `(around:${SEARCH_RADIUS_M},${center.lat},${center.lng})`;
    const selector = osmTag
      ? `[${osmTag}]`
      : `["name"~"${String(textQuery).replace(/["\\]/g, '\\$&')}",i]`;
    return `[out:json][timeout:25];(node${selector}${around};way${selector}${around};relation${selector}${around};);out center 40;`;
  };

  // Couleur/icône par famille de tag, pour distinguer les résultats sur la carte.
  const markerColorFor = (tags = {}) => {
    if (tags.amenity === 'restaurant' || tags.amenity === 'fast_food' || tags.amenity === 'cafe') return '#e8590c';
    if (tags.amenity === 'pharmacy') return '#2f9e44';
    if (tags.shop === 'beauty' || tags.shop === 'hairdresser') return '#c2255c';
    if (tags.shop === 'clothes') return '#7048e8';
    if (tags.shop === 'supermarket' || tags.shop === 'convenience') return '#1976d2';
    return '#1976d2';
  };

  /**
   * Lance une recherche de lieux autour de l'utilisateur.
   * @param {string} rawQuery contenu de la barre de recherche (peut être vide)
   * @param {string|null} osmTag tag OSM prioritaire, ex. "amenity=restaurant"
   */
  const performSearch = async (rawQuery = '', osmTag = null, rawLabel = '') => {
    // Après un rechargement à chaud, l'instance Leaflet du module peut avoir
    // été réinitialisée : on la recrée plutôt que de sortir sans rien dire.
    if (!map && typeof window.initializeMap === 'function') {
      window.initializeMap();
    }
    if (!map) {
      showToast('Carte indisponible : ouvrez d\'abord l\'onglet Carte.', 'error');
      return;
    }

    const textQuery = String(rawQuery || '').trim();
    // Si l'utilisateur a tapé directement un tag ("amenity=restaurant"), on
    // l'utilise comme tag ; sinon on cherche par nom.
    const inlineTag = /^[a-z_]+=[^\s,]+$/i.test(textQuery) ? textQuery : null;
    const tag = osmTag || inlineTag;

    if (!tag && !textQuery) {
      showToast('Saisissez une recherche ou choisissez une catégorie.', 'info');
      return;
    }
    // Jeton de requête : une recherche plus récente invalide l'affichage des
    // résultats (et le toast d'erreur) d'une recherche plus ancienne.
    const searchId = ++latestSearchId;

    isSearching = true;
    if (searchBtn) searchBtn.disabled = true;
    showToast('Recherche en cours…', 'info');

    try {
      const center = await getSearchCenter();
      if (!center || searchId !== latestSearchId) return;
      const places = await fetchPlaces(center, tag, textQuery, rawLabel);
      // Une recherche plus recente a pris la main : on jette ce resultat.
      if (searchId !== latestSearchId) return;

      removeSearchMarkers();

      places.forEach((place) => {
        const label = place.tags.name || place.tags.brand || tag || textQuery;
        const marker = L.circleMarker([place.lat, place.lon], {
          radius: 8,
          fillColor: markerColorFor(place.tags),
          color: '#ffffff',
          weight: 2,
          fillOpacity: 0.9,
        }).addTo(map);

        const address = [place.tags['addr:housenumber'], place.tags['addr:street']]
          .filter(Boolean)
          .join(' ');
        marker.bindPopup(`<strong>${escapeHtml(label)}</strong>${address ? `<br>${escapeHtml(address)}` : ''}`);
        searchMarkers.push(marker);
      });

      if (places.length > 0) {
        map.fitBounds(L.latLngBounds(places.map((p) => [p.lat, p.lon])), {
          padding: [40, 40],
          maxZoom: 16,
        });
        showToast(`${places.length} lieu(x) trouvé(s) — ${tag || textQuery}`, 'success');
      } else {
        showToast(`Aucun résultat pour ${tag || textQuery} dans un rayon de ${SEARCH_RADIUS_M / 1000} km.`, 'info');
      }
    } catch (error) {
      console.error('[Recherche] Échec :', error);
      // N'affiche l'erreur que si aucune recherche plus récente n'a pris la main.
      if (searchId === latestSearchId) {
        showToast('Erreur de recherche : aucune source de données disponible. Réessayez dans un instant.', 'error');
      }
    } finally {
      if (searchId === latestSearchId) {
        isSearching = false;
        if (searchBtn) searchBtn.disabled = false;
      }
    }
  };

  // Clic sur une catégorie : recherche avec le tag OSM du bouton.
  filterButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.category;
      if (!tag) return;

      // Re-cliquer sur la catégorie active la désélectionne.
      const alreadyActive = currentFilter === tag;
      currentFilter = alreadyActive ? null : tag;
      setActiveFilterButton(currentFilter);

      if (alreadyActive) {
        removeSearchMarkers();
        return;
      }

      // Barre vide -> le tag OSM et le libelle du bouton servent de requete.
      performSearch(searchInput ? searchInput.value : '', tag, btn.textContent.trim());
    });
  });

  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      currentFilter = null;
      setActiveFilterButton(null);
      if (searchInput) searchInput.value = '';
      removeSearchMarkers();
    });
  }

  // Bouton Recherche et touche Entrée : même fonction, avec le filtre actif.
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      if (shouldBlockSearch()) return;
      performSearch(searchInput ? searchInput.value : '', currentFilter);
    });
  }

  if (searchInput) {
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        performSearch(searchInput.value, currentFilter);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Planificateur d'itineraire (facon Citymapper)
  // Etape 1 : on ne calcule pas encore d'itineraire, on prepare les donnees
  // (depart geolocalise + arrivee geocodee) pour l'etape suivante.
  // -------------------------------------------------------------------------
  const routeDepartInput = document.getElementById('input-depart');
  const routeArriveeInput = document.getElementById('input-arrivee');
  const routeBtn = document.getElementById('btn-route');
  const routeSwapBtn = document.getElementById('btn-swap');
  let currentRoute = null;

  // Geocode une adresse libre via Nominatim (recherche mondiale, 1 resultat).
  const geocodeAddress = async (query) => {
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: query,
      limit: '1',
      addressdetails: '1',
      'accept-language': 'fr',
    });
    const url = `${NOMINATIM_ENDPOINT}?${params}`;
    // Meme adresse dans les 24 h : reponse servie par le cache.
    const { data } = await cachedJson(buildCacheKey('nominatim:geocode', [query.toLowerCase()]), url, {
      ttlMs: API_CACHE_TTL_MS,
      init: {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
      },
    });

    const rows = data;
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;

    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return {
      lat,
      lon,
      label: row.name || (row.display_name || '').split(',')[0],
      address: row.display_name || query,
    };
  };

  // -------------------------------------------------------------------------
  // Bottom sheet : itineraires proposes et trace sur la carte
  // -------------------------------------------------------------------------
  const routeSheet = document.getElementById('route-sheet');
  const routeListEl = document.getElementById('route-list');
  const routeSheetClose = document.getElementById('route-sheet-close');
  let routeLineLayers = [];

  const clearRouteLines = () => {
    if (map) routeLineLayers.forEach((layer) => map.removeLayer(layer));
    routeLineLayers = [];
  };

  // Trace l'itineraire : une polyline par etape, couleur selon le mode.
  const drawJourney = (journey) => {
    if (!map) return;
    clearRouteLines();

    journey.legs.forEach((leg) => {
      if (!Array.isArray(leg.coords) || leg.coords.length < 2) return;
      const line = L.polyline(leg.coords, {
        color: MODE_META[leg.mode]?.color || '#1976d2',
        weight: 5,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(map);
      routeLineLayers.push(line);
    });

    const points = journey.legs.flatMap((leg) => leg.coords || []);
    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [50, 50] });
    }
  };

  // ---------------------------------------------------------------------
  // Bottom sheet redimensionnable : glisser vers le haut pour agrandir,
  // vers le bas pour reduire. Trois positions d'accroche.
  // ---------------------------------------------------------------------
  const SHEET_SNAPS = { collapsed: 0.2, default: 0.5, expanded: 0.88 };
  let sheetSnapState = 'default';
  let sheetDragging = false;
  let sheetDragStartY = 0;
  let sheetDragStartHeight = 0;

  const applySheetSnap = (state = 'default') => {
    if (!routeSheet) return;
    sheetSnapState = SHEET_SNAPS[state] ? state : 'default';
    routeSheet.classList.remove('sheet-collapsed', 'sheet-expanded');
    if (sheetSnapState === 'collapsed') routeSheet.classList.add('sheet-collapsed');
    if (sheetSnapState === 'expanded') routeSheet.classList.add('sheet-expanded');
    routeSheet.style.height = `${Math.round(window.innerHeight * SHEET_SNAPS[sheetSnapState])}px`;
  };

  const snapStateForHeight = (height) => {
    const viewport = window.innerHeight;
    return Object.keys(SHEET_SNAPS).reduce((best, state) => (
      Math.abs(viewport * SHEET_SNAPS[state] - height) < Math.abs(viewport * SHEET_SNAPS[best] - height)
        ? state
        : best
    ), 'default');
  };

  const onSheetDragStart = (event) => {
    if (!routeSheet) return;
    // Le bouton de fermeture ne doit pas demarrer un glissement.
    if (event.target instanceof Element && event.target.closest('#route-sheet-close')) return;
    sheetDragging = true;
    sheetDragStartY = event.clientY;
    sheetDragStartHeight = routeSheet.getBoundingClientRect().height;
    routeSheet.classList.add('dragging');
    // Ecoute sur window : le glissement continue meme si le doigt sort de la
    // poignee, et aucun setPointerCapture n'est necessaire.
    window.addEventListener('pointermove', onSheetDragMove);
    window.addEventListener('pointerup', onSheetDragEnd);
    window.addEventListener('pointercancel', onSheetDragEnd);
    event.preventDefault();
  };

  const onSheetDragMove = (event) => {
    if (!sheetDragging || !routeSheet) return;
    const delta = sheetDragStartY - event.clientY; // vers le haut = agrandir
    const min = window.innerHeight * 0.15;
    const max = window.innerHeight * 0.92;
    const height = Math.min(max, Math.max(min, sheetDragStartHeight + delta));
    routeSheet.style.height = `${Math.round(height)}px`;
  };

  const onSheetDragEnd = () => {
    if (!sheetDragging || !routeSheet) return;
    sheetDragging = false;
    routeSheet.classList.remove('dragging');
    window.removeEventListener('pointermove', onSheetDragMove);
    window.removeEventListener('pointerup', onSheetDragEnd);
    window.removeEventListener('pointercancel', onSheetDragEnd);
    applySheetSnap(snapStateForHeight(routeSheet.getBoundingClientRect().height));
  };

  [routeSheet?.querySelector('.sheet-handle'), routeSheet?.querySelector('.sheet-head')]
    .filter(Boolean)
    .forEach((handle) => handle.addEventListener('pointerdown', onSheetDragStart));

  // Rotation / redimensionnement : on conserve la position d'accroche.
  window.addEventListener('resize', () => {
    if (routeSheet && routeSheet.classList.contains('open') && !sheetDragging) {
      applySheetSnap(sheetSnapState);
    }
  });

  const renderJourneys = (journeys, destination) => {
    if (!routeListEl) return;
    clearRouteLines();
    routeListEl.textContent = '';

    // Le badge « Le plus rapide » va a l'itineraire le plus court.
    const fastest = journeys.reduce((best, journey) => (
      !best || journey.durationMin < best.durationMin ? journey : best
    ), null);

    journeys.forEach((journey) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'route-card';
      card.dataset.journeyId = journey.id;

      const icon = document.createElement('span');
      icon.className = 'route-card-icon';
      icon.textContent = journey.icon;

      const body = document.createElement('span');
      body.className = 'route-card-body';

      const title = document.createElement('span');
      title.className = 'route-card-title';
      const duration = document.createElement('strong');
      duration.className = 'route-card-duration';
      duration.textContent = `${journey.durationMin} min`;
      const distance = document.createElement('span');
      distance.className = 'route-card-distance';
      distance.textContent = `${journey.distanceKm} km`;
      title.append(duration, distance);

      // Etapes separees par des fleches : « Marche 5 min → Metro 4 → … »
      const steps = document.createElement('span');
      steps.className = 'route-card-steps';
      journey.legs.forEach((leg, index) => {
        if (index > 0) {
          const arrow = document.createElement('span');
          arrow.className = 'route-arrow';
          arrow.textContent = '→';
          steps.append(arrow);
        }
        const step = document.createElement('span');
        step.className = 'route-step';
        const isStreet = leg.mode === 'walk' || leg.mode === 'bike' || leg.mode === 'car';
        const modeLabel = MODE_META[leg.mode]?.label || leg.mode;
        step.textContent = isStreet
          ? `${modeLabel} ${leg.durationMin} min`
          : (leg.label || `${modeLabel} ${leg.durationMin} min`);
        steps.append(step);
      });

      body.append(title, steps);
      card.append(icon, body);

      if (fastest && journey.id === fastest.id) {
        const badge = document.createElement('span');
        badge.className = 'route-card-badge';
        badge.textContent = 'Le plus rapide';
        card.append(badge);
      }

      card.addEventListener('click', () => {
        routeListEl.querySelectorAll('.route-card.active').forEach((el) => el.classList.remove('active'));
        card.classList.add('active');
        drawJourney(journey);
        showToast(`${journey.icon} ${journey.durationMin} min — ${journey.summary}`, 'info');
      });

      routeListEl.append(card);
    });

    const sheetTitle = document.getElementById('route-sheet-title');
    if (sheetTitle) {
      sheetTitle.textContent = destination ? `Itinéraires vers ${destination.label}` : 'Itinéraires';
    }
    if (routeSheet) {
      routeSheet.classList.add('open');
      routeSheet.setAttribute('aria-hidden', 'false');
      applySheetSnap('default');
    }
  };

  if (routeSheetClose) {
    routeSheetClose.addEventListener('click', () => {
      routeSheet?.classList.remove('open');
      routeSheet?.setAttribute('aria-hidden', 'true');
    });
  }

  // ---------------------------------------------------------------------
  // Garde-fou anti-clics repetes (protection des quotas API gratuits)
  // ---------------------------------------------------------------------
  const RATE_LIMIT_WINDOW_MS = 2000;
  const RATE_LIMIT_MAX_CLICKS = 5;
  const RATE_LIMIT_BLOCK_MS = 3000;
  let searchClickTimes = [];
  let searchBlockedUntil = 0;

  const isSearchBlocked = () => Date.now() < searchBlockedUntil;

  // Enregistre un clic ; renvoie true si la recherche doit etre bloquee.
  const shouldBlockSearch = () => {
    const now = Date.now();
    if (isSearchBlocked()) return true;

    searchClickTimes = searchClickTimes.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
    searchClickTimes.push(now);

    if (searchClickTimes.length < RATE_LIMIT_MAX_CLICKS) return false;

    // 5 clics en moins de 2 s : on bloque temporairement les boutons.
    searchBlockedUntil = now + RATE_LIMIT_BLOCK_MS;
    searchClickTimes = [];
    showToast('Veuillez patienter un instant avant de relancer une recherche.', 'warning');

    [searchBtn, routeBtn].filter(Boolean).forEach((button) => {
      button.disabled = true;
      window.setTimeout(() => {
        if (!isSearchBlocked()) button.disabled = false;
      }, RATE_LIMIT_BLOCK_MS + 50);
    });

    return true;
  };

  // Prepare { origin, destination } : depart = GPS/repli IP (ou texte saisi),
  // arrivee = adresse geocodee.
  const prepareRoute = async () => {
    if (shouldBlockSearch()) return;

    const departQuery = (routeDepartInput?.value || '').trim();
    const arriveeQuery = (routeArriveeInput?.value || '').trim();

    if (!arriveeQuery) {
      showToast('Indiquez une adresse d\'arrivée.', 'info');
      routeArriveeInput?.focus();
      return;
    }

    if (routeBtn) {
      routeBtn.disabled = true;
      routeBtn.textContent = 'Calcul…';
    }
    showToast('Calcul de l\'itinéraire...', 'info');

    try {
      // Depart : une adresse saisie prime sur la position automatique.
      let origin;
      if (departQuery) {
        const geocodedOrigin = await geocodeAddress(departQuery);
        if (!geocodedOrigin) {
          showToast(`Départ introuvable : ${departQuery}`, 'error');
          return;
        }
        origin = { ...geocodedOrigin, approximate: false };
      } else {
        const location = await resolveLocation();
        origin = {
          lat: location.lat,
          lon: location.lon,
          label: location.city ? `Ma position (${location.city})` : 'Ma position',
          address: location.city || 'Ma position',
          approximate: location.approximate,
        };
        if (location.approximate) {
          showToast('Localisation approximative utilisée (via IP)', 'warning');
        }
      }

      const destination = await geocodeAddress(arriveeQuery);
      if (!destination) {
        showToast(`Adresse introuvable : ${arriveeQuery}`, 'error');
        return;
      }

      currentRoute = {
        origin: { lat: origin.lat, lon: origin.lon, label: origin.label, address: origin.address, approximate: origin.approximate },
        destination: { lat: destination.lat, lon: destination.lon, label: destination.label, address: destination.address },
        preparedAt: new Date().toISOString(),
      };
      // Expose les donnees preparees (utile au trace et au debug).
      window.currentRoute = currentRoute;

      const journeys = await getJourneys(origin.lat, origin.lon, destination.lat, destination.lon);
      if (!journeys.length) {
        showToast('Aucun itinéraire trouvé pour ce trajet.', 'info');
        return;
      }

      renderJourneys(journeys, destination);

      const isDemo = journeys.some((journey) => journey.demo);
      showToast(
        isDemo
          ? `Démo (clé Navitia absente) : ${journeys.length} itinéraire(s)`
          : `${journeys.length} itinéraire(s) — ${destination.label}`,
        isDemo ? 'warning' : 'success',
      );
    } catch (error) {
      console.error('[Itinéraire] Préparation échouée :', error);
      showToast('Erreur : impossible de préparer l\'itinéraire.', 'error');
    } finally {
      if (routeBtn) {
        routeBtn.disabled = false;
        routeBtn.textContent = 'Rechercher un itinéraire';
      }
    }
  };

  if (routeBtn) {
    routeBtn.addEventListener('click', prepareRoute);
  }

  // Entree dans le champ d'arrivee = lancer la preparation.
  if (routeArriveeInput) {
    routeArriveeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        prepareRoute();
      }
    });
  }

  // Inverse depart et arrivee.
  if (routeSwapBtn) {
    routeSwapBtn.addEventListener('click', () => {
      if (!routeDepartInput || !routeArriveeInput) return;
      const depart = routeDepartInput.value;
      routeDepartInput.value = routeArriveeInput.value;
      routeArriveeInput.value = depart;
      routeArriveeInput.focus();
    });
  }

  // Initialize IndexedDB
  initIndexedDB();

  // Initialize text-to-speech
  initTextToSpeech();

  // Initialize speech recognition after DOM is ready
  initSpeechRecognition();
  addPulseAnimation();

  // Cache the microphone container and elements after a slight delay
  setTimeout(() => {
    domElements.microphoneContainer = document.getElementById('microphone-container');
    domElements.speechBubble = document.getElementById('speech-bubble');
    domElements.microphoneBtn = document.getElementById('microphone-btn');
    domElements.pulseIcon = domElements.microphoneBtn ? domElements.microphoneBtn.querySelector('span') : null;
    microphoneContainer = domElements.microphoneContainer;
    speechBubble = domElements.speechBubble;
    microphoneBtn = domElements.microphoneBtn;
    pulseIcon = domElements.pulseIcon;
    // Wire up the microphone button once elements are cached
    if (microphoneBtn) {
      microphoneBtn.addEventListener('click', toggleListening);
    }
  }, 100);

  // Function to toggle microphone listening
  const toggleListening = () => {
    if (!recognition) return;

    if (!isListening) {
      // Start listening
      try {
        recognition.start();
        isListening = true;
        
        // Show microphone button (only on Carte view)
        if (microphoneContainer) {
          microphoneContainer.style.display = 'block';
        }
      } catch (e) {
        console.error('Error starting speech recognition:', e);
        showToast('Erreur lors du démarrage de la reconnaissance vocale.', 'error');
      }
    } else {
      // Stop listening - this will trigger onend
      recognition.stop();
    }
  };

  const stopListening = () => {
    if (recognition && isListening) {
      recognition.stop();
      isListening = false;
    }
    
    // Hide microphone button
    if (microphoneContainer) {
      microphoneContainer.style.display = 'none';
    }
    
    // Reset button appearance
    if (microphoneBtn) {
      microphoneBtn.style.background = 'white';
      microphoneBtn.style.borderColor = '#e5e4e7';
      microphoneBtn.style.color = '#666';
      if (pulseIcon) {
        pulseIcon.style.animation = 'none';
      }
    }
    
    // Clear speech bubble
    if (speechBubble) {
      speechBubble.style.opacity = 0;
      speechBubble.textContent = '';
    }
  };

  // Bottom navigation tab functionality
  function showView(viewName) {
    const views = document.querySelectorAll('#views > div');
    views.forEach(view => {
      view.style.display = 'none';
    });

    const activeView = document.querySelector(`#views > div[data-view="${viewName}"]`);
    if (activeView) {
      // La carte est un conteneur flex ; les autres vues sont des blocs scrollables
      activeView.style.display = viewName === 'carte' ? 'flex' : 'block';
    }

    // La carte n'est visible que sur son propre onglet. Ailleurs, elle est
    // complètement retirée du flux pour laisser la place aux fenêtres opaques.
    const mapEl = document.getElementById('map');
    if (mapEl) {
      mapEl.style.display = viewName === 'carte' ? 'block' : 'none';
    }

    // Vue Mentions légales : hors de #views, gérée explicitement
    const mentionsViewEl = document.getElementById('view-mentions');
    if (mentionsViewEl) {
      mentionsViewEl.style.display = viewName === 'mentions-legales' ? 'block' : 'none';
    }

    // Show/hide microphone button only on Carte view
    if (microphoneContainer) {
      if (viewName === 'carte') {
        microphoneContainer.style.display = 'block';
      } else {
        microphoneContainer.style.display = 'none';
        // Stop listening when leaving Carte view
        if (isListening) {
          recognition.stop();
          isListening = false;
        }
      }
    }

    // Update bottom nav tab colors
    const tabs = document.querySelectorAll('#bottom-nav button');
    tabs.forEach(tab => {
      tab.style.color = '#6b6375'; // inactive color
    });

    // Activate the clicked tab
    const activeTab = document.querySelector(`#bottom-nav button[data-tab="${viewName}"]`);
    if (activeTab) {
      activeTab.style.color = '#000'; // active color (black for contrast)
    }

    // Call map.invalidateSize() when returning to Carte view
    if (viewName === 'carte') {
      if (!map) {
        initializeMap();
      } else {
        map.invalidateSize();
        // Small delay to ensure map is fully rendered
        setTimeout(() => {
          if (map) {
            map.invalidateSize();
          }
        }, 200);
      }
    }

    // Rafraîchit la marketplace à chaque ouverture de l'onglet Découvrir,
    // pour que les apps approuvées entre-temps apparaissent tout de suite.
    if (viewName === 'decouvrir') {
      renderMarketplace();
    }
  }

  // Set initial view to "carte" and initialize the map
  showView('carte');
  initializeMap();

  // Add click handlers to all bottom nav tabs
  const navTabs = document.querySelectorAll('#bottom-nav button');
  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const viewName = tab.getAttribute('data-tab');
      showView(viewName);
    });
  });

  // Voice toggle button click handler
  if (voiceToggleBtn) {
    voiceToggleBtn.addEventListener('click', () => {
      voiceEnabled = !voiceEnabled;
      localStorage.setItem('voiceEnabled', voiceEnabled.toString());
      updateVoiceButtonState();
    });
  }// Scanner initialization
  const scanner = new Html5Qrcode('reader');
  const startScanBtn = document.getElementById('start-scan-btn');
  const closeScannerBtn = document.getElementById('close-scanner');
  const scanResultEl = document.getElementById('scan-result');
  const productResultEl = document.getElementById('product-result');
  
  let isScanning = false;
  
  startScanBtn.addEventListener('click', async () => {
    try {
      // Show the reader container
      if (document.getElementById('reader')) {
        document.getElementById('reader').style.display = 'block';
      }
      
      // Start scanning with environment camera (rear on mobile)
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => ({
            width: Math.min(viewfinderWidth, 320),
            height: Math.min(viewfinderHeight, 110),
          }),
        },
        async (decodedText, decodedResult) => {
          // Code decoded successfully
          isScanning = false;
          startScanBtn.disabled = true;
          
          // Stop the camera immediately
          try {
            await scanner.stop();
          } catch (e) {
            // Ignore stop errors
          }
          
          // Hide reader, show loading spinner
          if (document.getElementById('reader')) {
            document.getElementById('reader').style.display = 'none';
          }
          if (document.getElementById('scan-result')) {
            document.getElementById('scan-result').textContent = 'Recherche du produit...';
          }
          
          // Fetch product from Open Food Facts
          if (document.getElementById('product-result')) {
            document.getElementById('product-result').innerHTML = '<p>Chargement du produit...</p>';
          }
          
          await fetchProductFromCode(decodedText);
        },
        (err) => {
          // Scan error or no code found - continue scanning
          // This is normal, just keep scanning
        }
      );
      
      isScanning = true;
      startScanBtn.disabled = true;
      scanResultEl.textContent = 'En scan...';
    } catch (err) {
      showToast('Impossible d\'accéder à la caméra: ' + err.message, 'error');
    }
  });
  
  closeScannerBtn.addEventListener('click', async () => {
    if (!isScanning) return;
    try {
      await scanner.stop();
      isScanning = false;
      startScanBtn.disabled = false;
      if (document.getElementById('reader')) {
        document.getElementById('reader').style.display = 'none';
      }
      if (productResultEl) {
        productResultEl.innerHTML = '';
      }
      if (document.getElementById('scan-result')) {
        document.getElementById('scan-result').textContent = '';
      }
    } catch (err) {
      showToast('Erreur arrêt scanner: ' + err.message, 'error');
    }
  });

  // Function to fetch product from Open Food Facts
  const fetchProductFromCode = async (code) => {
    // Check cache first
    const cachedProduct = await checkProductInCache(code);
    
    if (cachedProduct) {
      // Display product fiche from cache
      const product = cachedProduct;
      
      let additivesText = '';
      if (product.additives_tags && product.additives_tags.length > 0) {
        additivesText = 'Additifs: ' + product.additives_tags.map((t) => t.en || t).join(', ');
      }
      
      let allergensText = '';
      if (product.allergens_tags && product.allergens_tags.length > 0) {
        allergensText = 'Allergènes: ' + product.allergens_tags.map((t) => t.en || t).join(', ');
      }
      
      let novaText = '';
      if (product.nova_group !== undefined) {
        novaText = 'Groupe NOVA: ' + product.nova_group;
      }
      
      const nutriGrade = product.nutrition_grades || '?';
      const nutriColor = nutriGrade >= 'a' && nutriGrade <= 'e' ? '#4caf50' : '#f44336';
      
      // Add cache badge if product is from cache
      const cacheBadge = product.timestamp ? `<span style="position: absolute; top: 10px; right: 10px; background: #1976d2; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; z-index: 1000;" class="cache-badge">cache</span>` : '';
      
      productResultEl.innerHTML = `
        <div style="max-width: 500px; margin: 0 auto; padding: 20px; background: white; border: 1px solid #e5e4e7; border-radius: 8; text-align: left; position: relative;">${cacheBadge}
          <h3 style="margin: 0 0 16px 0; font-size: 18px;">${product.product_name || 'Produit inconnu'}</h3>
          ${product.image_url ? `<img src="${product.image_url}" alt="${product.product_name || ''}" style="width: 100%; height: auto; margin: 16px 0;">` : ''}
          <p style="margin: 8px 0; font-size: 14px; color: #6b6375;"><strong>Code:</strong> ${product.code || 'N/A'}</p>
          <p style="margin: 8px 0; font-size: 14px;"><strong>Nutri-Score:</strong> <span style="background: ${nutriColor}; color: white; padding: 2px 6px; border-radius: 3px; display: inline-block;">${nutriGrade || '?'}</span></p>
          ${additivesText ? `<p style="margin: 8px 0; font-size: 13px;">${additivesText}</p>` : ''}
          ${allergensText ? `<p style="margin: 8px 0; font-size: 13px;">${allergensText}</p>` : ''}
          <div style="margin-top: 12px; padding: 8px; border-radius: 8px; background: #f5f5f5; border-top: 1px solid #e5e4e7; font-size: 11px; color: #6b6375;">
            ⚠️ Information non médicale. Ces données proviennent d'Open Food Facts et ne remplacent pas l'avis d'un professionnel de santé.\n  <a href="https://world.openfoodfacts.org/product/${product.code}" style="color: #1976d2; text-decoration: underline;" target="_blank">Source : Open Food Facts</a>
          </div>
          ${voiceEnabled && voiceSynthesisSupported ? `<button style="padding: 8px 16px; font-size: 14px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; width: 100%;" onclick="lireFiche({ nom: '${product.product_name || 'Produit inconnu'}', nutriscore: '${product.nutrition_grades || '?'}', additifs: ${(product.additives_tags ? JSON.stringify(product.additives_tags.map((t) => t.en || t)) : '[]').replace(/"/g, '&quot;')})}">🔊 Écouter</button>` : ''}
          ${!product.timestamp ? `<button style="padding: 8px 16px; font-size: 14px; background: #ffc107; color: #111; border: none; border-radius: 4px; cursor: pointer; margin: 8px 0;">🔄 Rafraîchir</button>` : ''}
        </div>
      `;
      
      scanResultEl.textContent = `Produit trouvé (cache): ${product.product_name}`;
      return;
    }
    
    // Try Open Food Facts first
    try {
      const foodResponse = await fetch(`https://world.openfoodfacts.org/api/v3.6/product/${code}.json?fields=code,product_name,brands,nutrition_grades,additives_tags,allergens_tags,nova_group,code`);
      
      if (foodResponse.ok) {
        const foodData = await foodResponse.json();
        
        if (foodData.status === 'success' && foodData.product) {
          const product = foodData.product;
          
          // Store in cache
          await storeProductInCache(code, product);
          
          // Display product fiche from Open Food Facts
          let additivesText = '';
          if (product.additives_tags && product.additives_tags.length > 0) {
            additivesText = 'Additifs: ' + product.additives_tags.map((t) => t.en || t).join(', ');
          }
          
          let allergensText = '';
          if (product.allergens_tags && product.allergens_tags.length > 0) {
            allergensText = 'Allergènes: ' + product.allergens_tags.map((t) => t.en || t).join(', ');
          }
          
          let novaText = '';
          if (product.nova_group !== undefined) {
            novaText = 'Groupe NOVA: ' + product.nova_group;
          }
          
          const nutriGrade = product.nutrition_grades || '?';
          const nutriColor = nutriGrade >= 'a' && nutriGrade <= 'e' ? '#4caf50' : '#f44336';
          
          productResultEl.innerHTML = `
            <div style="max-width: 500px; margin: 0 auto; padding: 20px; background: white; border: 1px solid #e5e4e7; border-radius: 8; text-align: left;">
              <h3 style="margin: 0 0 16px 0; font-size: 18px;">${product.product_name || 'Produit inconnu'}</h3>
              ${product.image_url ? `<img src="${product.image_url}" alt="${product.product_name || ''}" style="width: 100%; height: auto; margin: 16px 0;">` : ''}
              <p style="margin: 8px 0; font-size: 14px; color: #6b6375;"><strong>Code:</strong> ${product.code || 'N/A'}</p>
              <p style="margin: 8px 0; font-size: 14px;"><strong>Nutri-Score:</strong> <span style="background: ${nutriColor}; color: white; padding: 2px 6px; border-radius: 3px; display: inline-block;">${nutriGrade || '?'}</span></p>
              ${additivesText ? `<p style="margin: 8px 0; font-size: 13px;">${additivesText}</p>` : ''}
              ${allergensText ? `<p style="margin: 8px 0; font-size: 13px;">${allergensText}</p>` : ''}
              <div style="margin-top: 12px; padding: 8px; border-radius: 8px; background: #f5f5f5; border-top: 1px solid #e5e4e7; font-size: 11px; color: #6b6375;">
                ⚠️ Information non médicale. Ces données proviennent d'Open Food Facts et ne remplacent pas l'avis d'un professionnel de santé.\n  <a href="https://world.openfoodfacts.org/product/${product.code}" style="color: #1976d2; text-decoration: underline;" target="_blank">Source : Open Food Facts</a>
              </div>
              ${voiceEnabled && voiceSynthesisSupported ? `<button style="padding: 8px 16px; font-size: 14px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; width: 100%;" onclick="lireFiche({ nom: '${product.product_name || 'Produit inconnu'}', nutriscore: '${product.nutrition_grades || '?'}', additifs: ${(product.additives_tags ? JSON.stringify(product.additives_tags.map((t) => t.en || t)) : '[]').replace(/"/g, '&quot;')})}">🔊 Écouter</button>` : ''}
              ${!product.timestamp ? `<button style="padding: 8px 16px; font-size: 14px; background: #ffc107; color: #111; border: none; border-radius: 4px; cursor: pointer; margin: 8px 0;">🔄 Rafraîchir</button>` : ''}
            </div>
          `;
          
          scanResultEl.textContent = `Produit trouvé: ${product.product_name}`;
          return;
        }
      }
    } catch (err) {
      console.error('Error fetching from Open Food Facts:', err);
      if (document.getElementById('scan-result')) {
        document.getElementById('scan-result').textContent = 'Erreur réseau. Réessaie.';
      }
      showToast('Erreur réseau. Réessaie.', 'error');
    }
    
    // Product not found in either database
    if (document.getElementById('scan-result')) {
      document.getElementById('scan-result').textContent = 'Produit inconnu';
    }
    if (document.getElementById('product-result')) {
      document.getElementById('product-result').innerHTML = '<p>Ce produit n\'est pas dans la base Open Food Facts.</p>';
    }
    showToast('Produit inconnu', 'error');
  };

  /* ==========================================================================
     ÉVOLUTION MAJEURE — Authentification, Espace développeur, Admin, Paiement
     Tout est local (IndexedDB + localStorage) : aucun serveur, aucune fuite.
     ========================================================================== */

  const AUTH_SESSION_KEY = 'freebuffMapUserEmail';

  // --- Échappement HTML : tous les champs viennent de l'utilisateur ---
  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // --- Hash « simple » : SHA-256 en contexte sécurisé, sinon repli déterministe ---
  const simpleHash = (text) => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(16, '0');
  };

  const hashPassword = async (password) => {
    try {
      if (window.crypto && window.crypto.subtle) {
        const buffer = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
        return Array.from(new Uint8Array(buffer))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      }
    } catch (error) {
      console.warn('[Auth] crypto.subtle indisponible, hash de secours utilisé.', error);
    }
    return simpleHash(password);
  };

  // --- Références DOM des nouvelles vues ---
  const profileUserNameEl = document.getElementById('profile-user-name');
  const navDevBtn = document.getElementById('btn-nav-dev');
  const navAuthBtn = document.getElementById('btn-nav-auth');
  const navPaymentBtn = document.getElementById('btn-nav-payment');
  const navAdminBtn = document.getElementById('btn-nav-admin');
  const logoutBtn = document.getElementById('btn-logout');
  const appLogoEl = document.getElementById('app-logo');

  const authMessageEl = document.getElementById('auth-message');
  const loginEmailInput = document.getElementById('login-email');
  const loginPasswordInput = document.getElementById('login-password');
  const loginSubmitBtn = document.getElementById('auth-login-btn');
  const signupNomInput = document.getElementById('signup-nom');
  const signupEmailInput = document.getElementById('signup-email');
  const signupPasswordInput = document.getElementById('signup-password');
  const signupSubmitBtn = document.getElementById('auth-signup-btn');
  const authTabButtons = document.querySelectorAll('[data-auth-tab]');
  const authLoginPanel = document.getElementById('auth-login-panel');
  const authSignupPanel = document.getElementById('auth-signup-panel');

  const devNomInput = document.getElementById('dev-nom');
  const devDescriptionInput = document.getElementById('dev-description');
  const devIconInput = document.getElementById('dev-icon');
  const devCategorieInput = document.getElementById('dev-categorie');
  const devUrlInput = document.getElementById('dev-url');
  const devSubmitBtn = document.getElementById('dev-submit');
  const devAppsListEl = document.getElementById('dev-apps-list');
  const adminAppsListEl = document.getElementById('admin-apps-list');

  // Utilisateur connecté (objet du store "users") ou null
  let currentUser = null;

  const setAuthMessage = (text, variant) => {
    if (!authMessageEl) return;
    authMessageEl.textContent = text || '';
    authMessageEl.className = 'fb-message' + (variant ? ' is-' + variant : '');
  };

  const readSessionEmail = () => {
    try {
      return localStorage.getItem(AUTH_SESSION_KEY);
    } catch (error) {
      return null;
    }
  };

  const writeSessionEmail = (email) => {
    try {
      if (email) {
        localStorage.setItem(AUTH_SESSION_KEY, email);
      } else {
        localStorage.removeItem(AUTH_SESSION_KEY);
      }
    } catch (error) {
      console.warn('[Auth] localStorage indisponible.', error);
    }
  };

  // --- Rendu : applications de l'utilisateur (Espace développeur) ---
  const renderDevApps = async () => {
    if (!devAppsListEl) return;

    let apps = [];
    try {
      apps = await dbAll('developer_apps');
    } catch (error) {
      console.error('[Dev] Lecture des applications impossible :', error);
      devAppsListEl.innerHTML = '<p class="fb-muted">Impossible de charger vos applications.</p>';
      return;
    }

    if (!currentUser) {
      devAppsListEl.innerHTML = '<p class="fb-muted">Connectez-vous pour voir vos applications.</p>';
      return;
    }

    const mine = apps
      .filter((app) => app && app.ownerEmail === currentUser.email)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (mine.length === 0) {
      devAppsListEl.innerHTML = '<p class="fb-muted">Aucune application soumise pour le moment.</p>';
      return;
    }

    devAppsListEl.innerHTML = mine.map((app) => {
      const badgeClass = app.statut === 'Approuvée'
        ? 'fb-badge-approuvee'
        : app.statut === 'Rejetée'
          ? 'fb-badge-rejetee'
          : 'fb-badge-attente';

      return `
        <div class="fb-app">
          <div class="fb-app-head">
            ${app.iconUrl
              ? `<img class="fb-app-icon" src="${escapeHtml(app.iconUrl)}" alt="" />`
              : '<span class="fb-app-icon" style="display:flex;align-items:center;justify-content:center;">📦</span>'}
            <div>
              <div class="fb-app-title">${escapeHtml(app.nom)}</div>
              <div class="fb-muted" style="font-size:12px;">${escapeHtml(app.categorie || 'Autre')}</div>
            </div>
          </div>
          <p class="fb-muted" style="margin:8px 0;font-size:13px;">${escapeHtml(app.description)}</p>
          <span class="fb-badge ${badgeClass}">${escapeHtml(app.statut || 'En attente')}</span>
          ${app.statut === 'Rejetée' && app.raisonRejet
            ? `<p class="fb-muted" style="margin:6px 0 0 0;font-size:12px;">Motif : ${escapeHtml(app.raisonRejet)}</p>`
            : ''}
        </div>
      `;
    }).join('');
  };

  // --- Rendu : applications en attente (Admin) ---
  const renderAdminApps = async () => {
    if (!adminAppsListEl) return;

    let apps = [];
    try {
      apps = await dbAll('developer_apps');
    } catch (error) {
      console.error('[Admin] Lecture des applications impossible :', error);
      adminAppsListEl.innerHTML = '<p class="fb-muted">Impossible de charger les applications.</p>';
      return;
    }

    const pending = apps
      .filter((app) => app && app.statut === 'En attente')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    if (pending.length === 0) {
      adminAppsListEl.innerHTML = '<p class="fb-muted">Aucune application en attente. 🎉</p>';
      return;
    }

    adminAppsListEl.innerHTML = pending.map((app) => `
      <div class="fb-app">
        <div class="fb-app-head">
          ${app.iconUrl
            ? `<img class="fb-app-icon" src="${escapeHtml(app.iconUrl)}" alt="" />`
            : '<span class="fb-app-icon" style="display:flex;align-items:center;justify-content:center;">📦</span>'}
          <div>
            <div class="fb-app-title">${escapeHtml(app.nom)}</div>
            <div class="fb-muted" style="font-size:12px;">${escapeHtml(app.categorie || 'Autre')} · ${escapeHtml(app.ownerEmail || 'inconnu')}</div>
          </div>
        </div>
        <p class="fb-muted" style="margin:8px 0;font-size:13px;">${escapeHtml(app.description)}</p>
        <p style="margin:6px 0;font-size:13px;">
          <a href="${escapeHtml(app.appUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(app.appUrl)}</a>
        </p>
        <div class="fb-app-actions">
          <button type="button" class="fb-approve" data-approve="${escapeHtml(String(app.id))}">Approuver</button>
          <button type="button" class="fb-reject" data-reject="${escapeHtml(String(app.id))}">Rejeter</button>
        </div>
      </div>
    `).join('');
  };

  // --- Synchronise l'interface avec la session courante ---
  const refreshAuthUI = async () => {
    const email = readSessionEmail();
    let user = null;

    if (email) {
      user = await dbGet('users', email);
      if (!user) {
        // Session orpheline : l'utilisateur n'existe plus dans IndexedDB
        writeSessionEmail(null);
      }
    }

    currentUser = user || null;

    if (profileUserNameEl) {
      if (currentUser) {
        profileUserNameEl.textContent = currentUser.nom + ' · ' + currentUser.email;
        profileUserNameEl.style.display = 'block';
      } else {
        profileUserNameEl.textContent = '';
        profileUserNameEl.style.display = 'none';
      }
    }

    if (navAuthBtn) navAuthBtn.style.display = currentUser ? 'none' : 'block';
    if (logoutBtn) logoutBtn.style.display = currentUser ? 'block' : 'none';

    if (navPaymentBtn) {
      if (currentUser && currentUser.isPremium) {
        navPaymentBtn.textContent = '⭐ Membre Premium';
        navPaymentBtn.disabled = true;
      } else {
        navPaymentBtn.textContent = '⭐ Passer Premium';
        navPaymentBtn.disabled = false;
      }
    }

    await renderDevApps();
  };

  // --- Onglets de la vue Auth ---
  const selectAuthTab = (tab) => {
    authTabButtons.forEach((button) => {
      button.classList.toggle('is-active', button.getAttribute('data-auth-tab') === tab);
    });
    if (authLoginPanel) authLoginPanel.style.display = tab === 'login' ? 'block' : 'none';
    if (authSignupPanel) authSignupPanel.style.display = tab === 'signup' ? 'block' : 'none';
    setAuthMessage('');
  };

  authTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      selectAuthTab(button.getAttribute('data-auth-tab'));
    });
  });

  // --- Inscription ---
  const handleSignup = async () => {
    setAuthMessage('');

    const nom = signupNomInput ? signupNomInput.value.trim() : '';
    const email = signupEmailInput ? signupEmailInput.value.trim().toLowerCase() : '';
    const password = signupPasswordInput ? signupPasswordInput.value : '';

    if (!nom || !email || !password) {
      setAuthMessage("Merci de remplir le nom, l'email et le mot de passe.", 'error');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAuthMessage("Cet email n'est pas valide.", 'error');
      return;
    }
    if (password.length < 6) {
      setAuthMessage('Le mot de passe doit contenir au moins 6 caractères.', 'error');
      return;
    }

    const existing = await dbGet('users', email);
    if (existing) {
      setAuthMessage('Un compte existe déjà avec cet email.', 'error');
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = { email, nom, passwordHash, isPremium: false, createdAt: Date.now() };

    // Clé inline (keyPath: 'email') : on ne passe donc pas de clé explicite
    const saved = await dbSet('users', undefined, user);
    if (!saved) {
      setAuthMessage('Impossible de créer le compte : stockage local indisponible.', 'error');
      return;
    }

    writeSessionEmail(email);
    if (signupNomInput) signupNomInput.value = '';
    if (signupEmailInput) signupEmailInput.value = '';
    if (signupPasswordInput) signupPasswordInput.value = '';

    await refreshAuthUI();
    showToast('Inscription réussie. Bienvenue ' + nom + ' !', 'success');
    showView('profil');
  };

  // --- Connexion ---
  const handleLogin = async () => {
    setAuthMessage('');

    const email = loginEmailInput ? loginEmailInput.value.trim().toLowerCase() : '';
    const password = loginPasswordInput ? loginPasswordInput.value : '';

    if (!email || !password) {
      setAuthMessage('Merci de saisir votre email et votre mot de passe.', 'error');
      return;
    }

    const user = await dbGet('users', email);
    if (!user) {
      setAuthMessage('Email ou mot de passe incorrect.', 'error');
      return;
    }

    const passwordHash = await hashPassword(password);
    if (passwordHash !== user.passwordHash) {
      setAuthMessage('Email ou mot de passe incorrect.', 'error');
      return;
    }

    writeSessionEmail(email);
    if (loginPasswordInput) loginPasswordInput.value = '';

    await refreshAuthUI();
    showToast('Bon retour, ' + (user.nom || user.email) + ' !', 'success');
    showView('profil');
  };

  if (loginSubmitBtn) loginSubmitBtn.addEventListener('click', handleLogin);
  if (signupSubmitBtn) signupSubmitBtn.addEventListener('click', handleSignup);

  [loginPasswordInput, signupPasswordInput].forEach((input) => {
    if (!input) return;
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (input === loginPasswordInput) handleLogin();
      else handleSignup();
    });
  });

  // --- Déconnexion ---
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      writeSessionEmail(null);
      currentUser = null;
      await refreshAuthUI();
      showToast('Vous êtes déconnecté.', 'info');
      showView('profil');
    });
  }

  // --- Espace développeur : soumission d'une application ---
  if (devSubmitBtn) {
    devSubmitBtn.addEventListener('click', async () => {
      if (!currentUser) {
        showToast('Connectez-vous pour soumettre une application.', 'warning');
        showView('auth');
        return;
      }

      const nom = devNomInput ? devNomInput.value.trim() : '';
      const description = devDescriptionInput ? devDescriptionInput.value.trim() : '';
      const iconUrl = devIconInput ? devIconInput.value.trim() : '';
      const categorie = devCategorieInput ? devCategorieInput.value : 'Autre';
      const appUrl = devUrlInput ? devUrlInput.value.trim() : '';

      if (!nom || !description || !appUrl) {
        showToast("Nom, description et lien de l'application sont obligatoires.", 'error');
        return;
      }

      const app = {
        nom,
        description,
        iconUrl,
        categorie,
        appUrl,
        statut: 'En attente',
        raisonRejet: '',
        ownerEmail: currentUser.email,
        createdAt: Date.now()
      };

      const saved = await dbSet('developer_apps', undefined, app);
      if (!saved) {
        showToast('Enregistrement impossible : stockage local indisponible.', 'error');
        return;
      }

      if (devNomInput) devNomInput.value = '';
      if (devDescriptionInput) devDescriptionInput.value = '';
      if (devIconInput) devIconInput.value = '';
      if (devUrlInput) devUrlInput.value = '';

      showToast('Application soumise — en attente de validation.', 'success');
      await renderDevApps();
    });
  }

  // --- Admin : changement de statut ---
  const updateAppStatus = async (id, statut, raisonRejet) => {
    const app = await dbGet('developer_apps', id);
    if (!app) {
      showToast('Application introuvable.', 'error');
      return false;
    }

    const updated = { ...app, statut, raisonRejet: raisonRejet || '' };
    const saved = await dbSet('developer_apps', undefined, updated);
    if (!saved) {
      showToast('Mise à jour impossible : stockage local indisponible.', 'error');
    }
    return saved;
  };

  if (adminAppsListEl) {
    adminAppsListEl.addEventListener('click', async (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;

      const approveId = target.getAttribute('data-approve');
      if (approveId !== null) {
        target.disabled = true;
        const ok = await updateAppStatus(Number(approveId), 'Approuvée', '');
        if (ok) showToast('Application approuvée.', 'success');
        await renderAdminApps();
        await renderDevApps();
        return;
      }

      const rejectId = target.getAttribute('data-reject');
      if (rejectId !== null) {
        const raison = window.prompt('Raison du rejet :');
        if (raison === null) return;

        const raisonClean = raison.trim();
        if (!raisonClean) {
          showToast('Une raison est requise pour rejeter une application.', 'error');
          return;
        }

        target.disabled = true;
        const ok = await updateAppStatus(Number(rejectId), 'Rejetée', raisonClean);
        if (ok) showToast('Application rejetée.', 'success');
        await renderAdminApps();
        await renderDevApps();
      }
    });
  }

  // --- Paiement (simulation, 2 secondes) ---
  const startSubscription = (plan, button) => {
    if (!currentUser) {
      showToast('Connectez-vous pour passer Premium.', 'warning');
      showView('auth');
      return;
    }

    showToast('Redirection vers le paiement sécurisé...', 'info');

    const planLabel = plan === 'annuel' ? 'Annuel (39.99€)' : 'Mensuel (4.99€)';
    if (button) {
      button.disabled = true;
      button.textContent = 'Traitement...';
    }

    window.setTimeout(async () => {
      try {
        const fresh = await dbGet('users', currentUser.email);
        if (!fresh) {
          showToast('Compte introuvable : reconnectez-vous.', 'error');
          return;
        }

        fresh.isPremium = true;
        fresh.premiumPlan = planLabel;
        fresh.premiumSince = Date.now();

        const saved = await dbSet('users', undefined, fresh);
        if (!saved) {
          showToast('Paiement simulé impossible : stockage local indisponible.', 'error');
          return;
        }

        currentUser = fresh;
        showToast('Bienvenue dans Premium !', 'success');
        await refreshAuthUI();
        showView('profil');
      } catch (error) {
        console.error('[Paiement] Erreur :', error);
        showToast('Une erreur est survenue pendant le paiement.', 'error');
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = "S'abonner";
        }
      }
    }, 2000);
  };

  document.querySelectorAll('[data-plan]').forEach((button) => {
    button.addEventListener('click', () => {
      startSubscription(button.getAttribute('data-plan'), button);
    });
  });

  // --- Navigation vers les nouvelles vues ---
  const openFeatureView = async (viewName) => {
    showView(viewName);
    if (viewName === 'developer') await renderDevApps();
    if (viewName === 'admin') await renderAdminApps();
    if (viewName === 'auth') setAuthMessage('');
  };

  if (navDevBtn) navDevBtn.addEventListener('click', () => { openFeatureView('developer'); });
  if (navAuthBtn) navAuthBtn.addEventListener('click', () => { openFeatureView('auth'); });
  if (navPaymentBtn) navPaymentBtn.addEventListener('click', () => { openFeatureView('payment'); });
  if (navAdminBtn) navAdminBtn.addEventListener('click', () => { openFeatureView('admin'); });

  document.querySelectorAll('[data-back]').forEach((button) => {
    button.addEventListener('click', () => {
      showView(button.getAttribute('data-back') || 'profil');
    });
  });

  // Mentions légales : le bouton du profil n'avait aucun écouteur
  const mentionsBtn = document.getElementById('mentions-legales-btn');
  if (mentionsBtn) {
    mentionsBtn.addEventListener('click', () => { showView('mentions-legales'); });
  }

  const backToProfilBtn = document.getElementById('back-to-profil');
  if (backToProfilBtn) {
    backToProfilBtn.addEventListener('click', () => { showView('profil'); });
  }

  // --- Accès admin secret : 5 clics sur le logo (vue Profil) ---
  if (appLogoEl && navAdminBtn) {
    let logoClicks = 0;
    let logoClickTimer = null;

    appLogoEl.addEventListener('click', () => {
      logoClicks += 1;

      if (logoClickTimer) window.clearTimeout(logoClickTimer);
      logoClickTimer = window.setTimeout(() => {
        logoClicks = 0;
      }, 2000);

      if (logoClicks >= 5) {
        logoClicks = 0;
        if (logoClickTimer) window.clearTimeout(logoClickTimer);
        navAdminBtn.style.display = 'block';
        showToast('Panneau admin débloqué.', 'success');
      }
    });
  }

  // --- État initial de la session ---
  selectAuthTab('login');
  refreshAuthUI().catch((error) => {
    console.error('[Auth] Initialisation de la session impossible :', error);
  });

  /* ==========================================================================
     MARKETPLACE — affichage public des applications approuvées
     ========================================================================== */

  const decouvrirGridEl = document.getElementById('decouvrir-grid');
  const decouvrirSearchInput = document.getElementById('decouvrir-search');

  const renderMarketplace = async () => {
    if (!decouvrirGridEl) return;

    let apps = [];
    try {
      apps = await dbAll('developer_apps');
    } catch (error) {
      console.error('[Découvrir] Lecture des applications impossible :', error);
      decouvrirGridEl.innerHTML = '<p class="fb-muted">Impossible de charger les applications.</p>';
      return;
    }

    const query = (decouvrirSearchInput ? decouvrirSearchInput.value : '').trim().toLowerCase();

    const approved = apps
      .filter((app) => app && app.statut === 'Approuvée')
      .filter((app) => {
        if (!query) return true;
        const nom = String(app.nom || '').toLowerCase();
        const categorie = String(app.categorie || '').toLowerCase();
        return nom.includes(query) || categorie.includes(query);
      })
      .sort((a, b) => String(a.nom || '').localeCompare(String(b.nom || ''), 'fr'));

    if (approved.length === 0) {
      const message = query
        ? 'Aucune application ne correspond à cette recherche.'
        : 'Aucune application disponible pour le moment.';
      decouvrirGridEl.innerHTML = `<p class="fb-muted" style="grid-column: 1 / -1; text-align: center;">${message}</p>`;
      return;
    }

    decouvrirGridEl.innerHTML = approved.map((app) => `
      <article class="fb-app-card">
        <div class="fb-app-card-icon">
          ${app.iconUrl
            ? `<img src="${escapeHtml(app.iconUrl)}" alt="" loading="lazy" />`
            : '📦'}
        </div>
        <h3 class="fb-app-card-title">${escapeHtml(app.nom)}</h3>
        <span class="fb-badge" style="background:#eef3fb;color:#1976d2;">${escapeHtml(app.categorie || 'Autre')}</span>
        <p class="fb-app-card-desc">${escapeHtml(app.description)}</p>
        <a class="fb-btn fb-btn-primary" style="margin:0;" href="${escapeHtml(app.appUrl)}" target="_blank" rel="noopener noreferrer">Ouvrir</a>
      </article>
    `).join('');
  };

  if (decouvrirSearchInput) {
    decouvrirSearchInput.addEventListener('input', () => {
      renderMarketplace();
    });
  }

  /* ==========================================================================
     ONBOARDING — première expérience (3 écrans)
     ========================================================================== */

  const ONBOARDING_KEY = 'onboarding_done';
  const onboardingOverlay = document.getElementById('onboarding-overlay');
  const onboardingSlides = onboardingOverlay
    ? onboardingOverlay.querySelectorAll('[data-onboarding-step]')
    : [];
  const onboardingDots = onboardingOverlay
    ? onboardingOverlay.querySelectorAll('[data-onboarding-dot]')
    : [];
  const onboardingNextBtn = document.getElementById('onboarding-next');
  const onboardingSkipBtn = document.getElementById('onboarding-skip');

  let onboardingIndex = 0;

  const showOnboardingStep = (index) => {
    if (onboardingSlides.length === 0) return;

    onboardingIndex = Math.max(0, Math.min(index, onboardingSlides.length - 1));

    onboardingSlides.forEach((slide, i) => {
      slide.style.display = i === onboardingIndex ? 'block' : 'none';
    });

    onboardingDots.forEach((dot, i) => {
      dot.classList.toggle('is-active', i === onboardingIndex);
    });

    if (onboardingNextBtn) {
      onboardingNextBtn.textContent = onboardingIndex === onboardingSlides.length - 1
        ? "C'est parti !"
        : 'Suivant';
    }
  };

  const closeOnboarding = () => {
    if (onboardingOverlay) onboardingOverlay.style.display = 'none';
    try {
      localStorage.setItem(ONBOARDING_KEY, 'true');
    } catch (error) {
      console.warn('[Onboarding] localStorage indisponible.', error);
    }
  };

  if (onboardingOverlay) {
    if (onboardingNextBtn) {
      onboardingNextBtn.addEventListener('click', () => {
        if (onboardingIndex >= onboardingSlides.length - 1) {
          closeOnboarding();
        } else {
          showOnboardingStep(onboardingIndex + 1);
        }
      });
    }

    if (onboardingSkipBtn) {
      onboardingSkipBtn.addEventListener('click', closeOnboarding);
    }

    let onboardingDone = null;
    try {
      onboardingDone = localStorage.getItem(ONBOARDING_KEY);
    } catch (error) {
      onboardingDone = null;
    }

    if (onboardingDone === null) {
      showOnboardingStep(0);
      onboardingOverlay.style.display = 'flex';
    }
  }
});

// IndexedDB cache operations (comparateur offers)
const checkComparateurCache = async (storeName, key) => {
  try {
    return await dbGet(storeName, key);
  } catch (error) {
    console.error('Cache check error:', error);
    return null;
  }
};

// Store comparateur offers in IndexedDB cache
const storeComparateurCache = async (storeName, key, results) => {
  try {
    // Le store 'offres' utilise une clé inline (keyPath 'id') : pas de clé explicite
    await dbSet(storeName, undefined, { id: key, query: key, timestamp: Date.now(), results });
    return true;
  } catch (error) {
    console.error('Cache store error:', error);
    return false;
  }
};

// Display comparer results
const displayComparateurResults = (results) => {
  if (!results || results.length === 0) {
    comparateurResultsEl.innerHTML = '<p>Aucun résultat trouvé</p>';
    return;
  }

  // Render results with the default (équilibré) weights
  displayComparateurResultsWithWeights(comparateurResultsEl, results, { prixWeight: 0.6, distanceWeight: 0.4 });
};

// Comparateur view functionality
const comparateurInput = document.getElementById('comparateur-input');
const comparateurBtn = document.getElementById('comparateur-btn');
const comparateurResultsEl = document.getElementById('comparateur-results');

// Search handler
const searchProducts = async (query) => {
  if (!query.trim()) return;

  // Check cache first
  const cached = await checkComparateurCache('offres', query.toLowerCase());
  if (cached) {
    cachedComparateurResults = cached.results;
    displayComparateurResults(cached.results);
    return;
  }

  // Use Amazon Associates API or generate affiliate link
  const affiliateLink = `https://www.amazon.fr/s?k=${encodeURIComponent(query)}&tag=${AMAZON_TAG}`;

  try {
    // Try to fetch from Amazon Partners API (if credentials available)
    // For now, generate mock results
    // Product A: physical with distance, Product B: physical with distance, Product C: online with delay
    // Données simulées en attendant une API de réductions (Ohmydeal, ReefAPI…) :
    // chaque offre expose discount (%), price/prix, distance et originalPrice.
    const results = [{
      name: 'Chaussures de sport - Modèle A',
      image: '/placeholder-image.png',
      prix: 49.99,
      price: '49.99 €',
      originalPrice: 69.99,
      discount: 29,
      distance: 2,        // 2 km du magasin
      delaiLivraison: 0,  // Pas de délai
      affiliateLink: affiliateLink
    }, {
      name: 'Chaussures de running - Modèle B',
      image: '/placeholder-image.png',
      prix: 45.00,
      price: '45.00 €',
      originalPrice: 59.90,
      discount: 25,
      distance: 5,        // 5 km du magasin
      delaiLivraison: 0,  // Pas de délai
      affiliateLink: affiliateLink
    }, {
      name: 'Baskets tendance - Modèle C',
      image: '/placeholder-image.png',
      prix: 42.00,
      price: '42.00 €',
      originalPrice: 60.00,
      discount: 30,
      distance: 0,        // Produit en ligne
      delaiLivraison: 3,  // 3 jours de délai
      affiliateLink: affiliateLink,
      // Partenaire Awin : dès qu'un produit expose un advertiserId, son lien
      // d'achat passe par le Link Builder Awin (repli sur affiliateLink si échec).
      advertiserId: AWIN_ADVERTISER_EXAMPLE_ID,
      destinationUrl: `https://www.amazon.fr/s?k=${encodeURIComponent(query)}`
    }];

    // Store in IndexedDB cache
    await storeComparateurCache('offres', query.toLowerCase(), results);

    cachedComparateurResults = results;
    displayComparateurResultsWithWeights(comparateurResultsEl, results, currentWeights);
  } catch (err) {
    console.error('Error searching products:', err);
    showToast('Erreur lors de la recherche', 'error');
  }
}

// Add click handler to compare button
comparateurBtn.addEventListener('click', () => {
  const query = comparateurInput.value;
  searchProducts(query);
});;

// Display comparer results
const calculateScore = (product, weights = { prixWeight: 0.6, distanceWeight: 0.4 }) => {
  const prixProduit = product.prix || 0;
  const fraisPort = product.fraisPort || 0;
  const distance = product.distance || 0;
  const delaiLivraison = product.delaiLivraison || 0;
  
  let prixTotal, distanceScore; 
  
  // Calculate total price and distance/delay score
  if (distance > 0) {
    // Physical product with distance
    prixTotal = prixProduit + fraisPort + (distance * 0.35);
    distanceScore = distance; 
  } else {
    // Online product - use delivery delay instead of distance
    prixTotal = prixProduit + fraisPort;
    distanceScore = delaiLivraison * 0.5;
  }
  
  // Final score with custom weights: (Prix total × prixWeight) + (Distance/Delay × distanceWeight)
  const score = (prixTotal * weights.prixWeight) + (distanceScore * weights.distanceWeight);
  return score;
};

// Priority selector
const priorityRadios = document.createElement('div');
priorityRadios.innerHTML = `
  <p style="margin: 8px 0; font-size: 14px; font-weight: 500;">Priorité</p>
  <label style="margin-right: 20px; font-size: 13px;">
    <input type="radio" name="priority" value="prix" checked>
    Prix (0.8/0.2)
  </label>
  <label style="margin-right: 20px; font-size: 13px;">
    <input type="radio" name="priority" value="equilibre">
    Équilibré (0.6/0.4)
  </label>
  <label style="font-size: 13px;">
    <input type="radio" name="priority" value="proximite">
    Proximité (0.3/0.7)
  </label>
`;

priorityRadios.style.cssText = `
  margin: 12px 0;
  display: flex;
  gap: 20px;
  align-items: center;
  font-family: inherit;
`;

let currentWeights = { prixWeight: 0.6, distanceWeight: 0.4 };

let cachedComparateurResults = null;

// Tri courant du comparateur (cf. sélecteur #deal-sort).
let currentSort = 'discount';
const dealSortSelect = document.getElementById('deal-sort');

// --- Tri des offres --------------------------------------------------------
// Structure prête pour une API de réductions (Ohmydeal, ReefAPI…) : il suffit
// de normaliser chaque offre en { name, price, discount, distance }.
// `price` peut être un libellé ("49.99 €") et `prix` le nombre : on retient
// toujours la première valeur réellement numérique, sinon on extrait le nombre.
const dealPrice = (deal) => {
  for (const candidate of [deal.price, deal.prix, deal.prixTotal]) {
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  const parsed = String(deal.price ?? '').replace(',', '.').match(/\d+(\.\d+)?/);
  return parsed ? Number(parsed[0]) : Number.POSITIVE_INFINITY;
};

const dealDistance = (deal) => {
  const value = Number(deal.distance);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
};

const dealDiscount = (deal) => {
  const value = Number(deal.discount);
  return Number.isFinite(value) ? value : 0;
};

/**
 * Trie les offres du comparateur (sans modifier le tableau d'origine).
 * @param {Array<object>} deals offres, chacune avec { discount, price, distance }
 * @param {'discount'|'price'|'distance'} mode critère prioritaire
 * @returns {Array<object>} nouveau tableau trié
 */
const sortDeals = (deals, mode = 'discount') => {
  const list = Array.isArray(deals) ? [...deals] : [];

  switch (mode) {
    case 'price':
      // Prix le plus bas, puis meilleure réduction, puis distance.
      return list.sort((a, b) =>
        dealPrice(a) - dealPrice(b) ||
        dealDiscount(b) - dealDiscount(a) ||
        dealDistance(a) - dealDistance(b));

    case 'distance':
      // Le plus proche, puis meilleure réduction, puis prix.
      return list.sort((a, b) =>
        dealDistance(a) - dealDistance(b) ||
        dealDiscount(b) - dealDiscount(a) ||
        dealPrice(a) - dealPrice(b));

    case 'discount':
    default:
      // Réduction la plus forte, puis prix croissant, puis distance croissante.
      return list.sort((a, b) =>
        dealDiscount(b) - dealDiscount(a) ||
        dealPrice(a) - dealPrice(b) ||
        dealDistance(a) - dealDistance(b));
  }
};

const updatePriority = () => {
  const selected = document.querySelector('input[name="priority"]:checked');
  if (!selected) return;
  
  const value = selected.value;
  
  switch (value) {
    case 'prix':
      currentWeights = { prixWeight: 0.8, distanceWeight: 0.2 };
      break;
    case 'equilibre':
      currentWeights = { prixWeight: 0.6, distanceWeight: 0.4 };
      break;
    case 'proximite':
      currentWeights = { prixWeight: 0.3, distanceWeight: 0.7 };
      break;
  }
  
  // Le choix de priorité correspond au tri « Pertinence » du sélecteur.
  if (dealSortSelect) {
    currentSort = 'score';
    dealSortSelect.value = 'score';
  }

  // Re-sort and display with new weights
  displayComparateurResultsWithWeights(comparateurResultsEl, cachedComparateurResults || [], currentWeights);
};

// Display comparer results with custom weights
const displayComparateurResultsWithWeights = (resultsEl, results, weights) => {
  if (!results || results.length === 0) {
    resultsEl.innerHTML = '<p>Aucun résultat trouvé</p>';
    return;
  }

  // Calculate scores with current weights
  const scoredResults = [...results].map(product => ({
    ...product,
    score: calculateScore(product, weights)
  }));

  // Ordre par défaut : score (priorité). Le sélecteur de tri, lui, prime.
  scoredResults.sort((a, b) => a.score - b.score);

  // « Pertinence » conserve l'ordre par score ; les autres modes appliquent
  // le tri des offres (réduction, prix, distance).
  const orderedResults = currentSort === 'score'
    ? scoredResults
    : sortDeals(scoredResults, currentSort);

  resultsEl.innerHTML = orderedResults.map((product) => {
    // Données de lecture vocale, échappées pour un attribut HTML (" → &quot;)
    const lireData = JSON.stringify({
      nom: product.name,
      prix: product.prix,
      magasin: product.magasin || 'Amazon',
      distance: product.distance || 0,
      montantEconomise: product.montantEconomise || 0
    }).replace(/"/g, '&quot;');

    // Attributs data-* : le href sera remplacé par le lien de suivi Awin une
    // fois généré (hydratation asynchrone, après l'affichage de la liste).
    const awinAttrs = product.advertiserId
      ? `data-awin-advertiser="${escapeHtmlAttr(product.advertiserId)}" data-awin-destination="${escapeHtmlAttr(product.destinationUrl || product.affiliateLink || '')}" data-awin-status="pending"`
      : '';

    // Badge de réduction : fourni par l'API (discount), ou déduit d'un prix barré.
    const discountValue = Number(
      product.discount
      ?? (product.originalPrice && product.prix
        ? (1 - product.prix / product.originalPrice) * 100
        : 0)
    );
    const discountBadge = Number.isFinite(discountValue) && discountValue > 0
      ? `<span style="display: inline-block; padding: 4px 10px; background: #e53935; color: #fff; border-radius: 999px; font-size: 13px; font-weight: 700; white-space: nowrap;">-${Math.round(discountValue)}%</span>`
      : '';

    return `
    <div data-offer-card style="border: 1px solid #e5e4e7; border-radius: 8px; padding: 16px; margin: 12px 0; background: white; transition: transform 0.2s; cursor: pointer;" onclick="window.lireComparateur(${lireData});">
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;">
        <h3 style="margin: 0; font-size: 16px;">${product.name || 'Produit inconnu'}</h3>
        ${discountBadge}
      </div>
      ${product.image ? `<img src="${product.image}" alt="${product.name || ''}" style="width: 100px; height: auto; margin: 8px 0;">` : ''}
      <p style="margin: 4px 0; font-size: 14px; color: #6b6375;">${product.price || 'Prix non disponible'}</p>
      ${product.score !== undefined ? `<p style="margin: 4px 0; font-size: 12px; color: #2e7d32; font-weight: 500;">Score: ${product.score.toFixed(2)}</p>` : ''}
      <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: baseline;">
        <a
          href="${product.affiliateLink}"
          ${awinAttrs}
          style="
            flex: 1;
            padding: 6px 12px;
            background: #ffb300;
            color: #111;
            font-size: 13px;
            font-weight: 500;
            border-radius: 4px;
            text-decoration: none;
            margin-right: 4px;
          "
        >
          Acheter
          <span style="margin-left: 4px; font-size: 11px; color: #666;">Lien affilié : nous percevons une commission</span>
        </a>
        <button
          style="
            padding: 6px 12px;
            background: #1976d2;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            margin-left: 4px;
          "
          onclick="event.stopPropagation(); window.lireComparateur(${lireData});">
          🔊 Écouter
        </button>
        <button
          style="
            padding: 6px 12px;
            background: #e5e4e7;
            color: #333;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            margin-left: 4px;
          "
          onclick="event.stopPropagation(); window.lireComparateur(${lireData});">
          🔁 Répéter
        </button>
      </div>
    </div>
  `;
  }).join('');

  // Remplace les liens de secours par les liens de suivi Awin (asynchrone :
  // la liste est déjà affichée, les hrefs sont mis à jour ensuite).
  hydrateAwinLinks(resultsEl);
};

// Attach priority selector event listeners
const priorityInputs = document.querySelectorAll('input[name="priority"]');
priorityInputs.forEach(input => {
  input.addEventListener('change', updatePriority);
});

// Sélecteur de tri des offres (Réduction max / Prix / Proximité)
if (dealSortSelect) {
  dealSortSelect.addEventListener('change', () => {
    currentSort = dealSortSelect.value || 'discount';
    displayComparateurResultsWithWeights(comparateurResultsEl, cachedComparateurResults || [], currentWeights);
  });
}

// Initial display with default weights
displayComparateurResultsWithWeights(comparateurResultsEl, cachedComparateurResults || [], currentWeights);

// Le sélecteur de priorité est déjà présent dans index.html (vue Comparateur) — pas d'insertion en double

