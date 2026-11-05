// db.js - IndexedDB helper module
// Consolidated stores: recherches, produits, offres
// All functions use the shared 'MonApp' database

let db = null;

// Open (or re-open) the database
const DB_NAME = 'MonApp';
// v2 : ajout des stores "developer_apps" (apps soumises) et "users" (comptes locaux)
// v3 : ajout du store "cache" (reponses API Nominatim / Navitia)
const DB_VERSION = 3;

const openDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Create object stores if they don't exist
      if (!db.objectStoreNames.contains('recherches')) {
        const rechercheStore = db.createObjectStore('recherches', { keyPath: 'id', autoIncrement: true });
        rechercheStore.createIndex('query_idx', 'query', { unique: false });
        rechercheStore.createIndex('timestamp_idx', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains('produits')) {
        db.createObjectStore('produits', { keyPath: 'code', autoIncrement: false });
      }
      if (!db.objectStoreNames.contains('offres')) {
        const offreStore = db.createObjectStore('offres', { keyPath: 'id', autoIncrement: true });
        offreStore.createIndex('query_idx', 'query', { unique: false });
        offreStore.createIndex('timestamp_idx', 'timestamp', { unique: false });
      }
      // Applications soumises par les développeurs (clé auto-incrémentée)
      if (!db.objectStoreNames.contains('developer_apps')) {
        const devStore = db.createObjectStore('developer_apps', { keyPath: 'id', autoIncrement: true });
        devStore.createIndex('statut_idx', 'statut', { unique: false });
        devStore.createIndex('owner_idx', 'ownerEmail', { unique: false });
      }
      // Comptes locaux : l'email sert de clé primaire
      if (!db.objectStoreNames.contains('users')) {
        db.createObjectStore('users', { keyPath: 'email' });
      }
      // Cache des reponses API (Nominatim, Navitia) avec date d'expiration
      if (!db.objectStoreNames.contains('cache')) {
        const cacheStore = db.createObjectStore('cache', { keyPath: 'key' });
        cacheStore.createIndex('expires_idx', 'expiresAt', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.error);
      reject(event.target.error);
    };
  });
};

// Get an item from a store by key
const dbGet = async (store, key) => {
  try {
    await openDB();
    if (!db) return null;
    const transaction = db.transaction(store, 'readonly');
    const storeObj = transaction.objectStore(store);
    const request = storeObj.get(key);
    return new Promise((resolve) => {
      request.onsuccess = () => {
        resolve(request.result ? request.result : null);
      };
      request.onerror = () => {
        resolve(null);
      };
    });
  } catch (error) {
    console.error(`dbGet error for store ${store}:`, error);
    return null;
  }
};

// Set an item in a store
const dbSet = async (store, key, value) => {
  try {
    await openDB();
    if (!db) return false;
    const transaction = db.transaction(store, 'readwrite');
    const storeObj = transaction.objectStore(store);
    // If key is provided, use it; otherwise let autoIncrement assign
    const request = key !== undefined ? storeObj.put(value, key) : storeObj.put(value);
    return new Promise((resolve) => {
      request.onsuccess = () => {
        resolve(true);
      };
      request.onerror = () => {
        resolve(false);
      };
    });
  } catch (error) {
    console.error(`dbSet error for store ${store}:`, error);
    return false;
  }
};

// Delete an item from a store by key
const dbDelete = async (store, key) => {
  try {
    await openDB();
    if (!db) return false;
    const transaction = db.transaction(store, 'readwrite');
    const storeObj = transaction.objectStore(store);
    const request = storeObj.delete(key);
    return new Promise((resolve) => {
      request.onsuccess = () => {
        resolve(true);
      };
      request.onerror = () => {
        resolve(false);
      };
    });
  } catch (error) {
    console.error(`dbDelete error for store ${store}:`, error);
    return false;
  }
};

// Clear all items from a store
const dbClear = async (store) => {
  try {
    await openDB();
    if (!db) return false;
    const transaction = db.transaction(store, 'readwrite');
    const storeObj = transaction.objectStore(store);
    const request = storeObj.clear();
    return new Promise((resolve) => {
      request.onsuccess = () => {
        resolve(true);
      };
      request.onerror = () => {
        resolve(false);
      };
    });
  } catch (error) {
    console.error(`dbClear error for store ${store}:`, error);
    return false;
  }
};

// Get all items from a store
const dbAll = async (store) => {
  try {
    await openDB();
    if (!db) return [];
    const transaction = db.transaction(store, 'readonly');
    const storeObj = transaction.objectStore(store);
    const request = storeObj.openCursor();
    return new Promise((resolve) => {
      const results = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        }
        resolve(results);
      };
      request.onerror = () => {
        resolve([]);
      };
    });
  } catch (error) {
    console.error(`dbAll error for store ${store}:`, error);
    return [];
  }
};

export { openDB, dbGet, dbSet, dbDelete, dbClear, dbAll };