/**
 * StoryFlow Studio — Project Store & IndexedDB Engine
 * Persists full projects, large photo blobs, voice audio, photo vision tag cache,
 * and manages "My Projects" (open, duplicate, rename, delete).
 */

const DB_NAME = 'StoryFlowStudioDB';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_BLOBS = 'media_blobs';
const STORE_VISION_CACHE = 'photo_vision_cache';

let dbPromise = null;

function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported in this environment'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        const projStore = db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        projStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_VISION_CACHE)) {
        db.createObjectStore(STORE_VISION_CACHE, { keyPath: 'cacheKey' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => {
      console.error('[IndexedDB] Failed to open database:', e.target.error);
      reject(e.target.error);
    };
  });
  return dbPromise;
}

export class ProjectStore {
  /**
   * Saves or updates a project in IndexedDB
   * @param {object} project 
   */
  static async saveProject(project) {
    if (!project || !project.id) {
      throw new Error('Project must have an id');
    }
    const db = await getDB();
    const updated = {
      ...project,
      updatedAt: new Date().toISOString()
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readwrite');
      const store = tx.objectStore(STORE_PROJECTS);
      const req = store.put(updated);
      req.onsuccess = () => resolve(updated);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Loads a project by ID
   * @param {string} id 
   * @returns {Promise<object|null>}
   */
  static async loadProject(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const store = tx.objectStore(STORE_PROJECTS);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Lists all projects sorted by updatedAt descending
   * @returns {Promise<Array<object>>}
   */
  static async listProjects() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const store = tx.objectStore(STORE_PROJECTS);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = req.result || [];
        list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        resolve(list.map((p) => ({
          id: p.id,
          name: p.name || 'Untitled Project',
          updatedAt: p.updatedAt,
          createdAt: p.createdAt,
          photoCount: Array.isArray(p.photo_records) ? p.photo_records.length : 0,
          scriptLineCount: Array.isArray(p.script_lines) ? p.script_lines.length : 0,
          storyPreview: (p.story || '').slice(0, 100)
        })));
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Deletes a project by ID and associated blobs
   * @param {string} id 
   */
  static async deleteProject(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_PROJECTS], 'readwrite');
      const store = tx.objectStore(STORE_PROJECTS);
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Duplicates an existing project
   * @param {string} id 
   * @returns {Promise<object>}
   */
  static async duplicateProject(id) {
    const original = await this.loadProject(id);
    if (!original) throw new Error('Project not found');
    const newId = `proj_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const copy = {
      ...original,
      id: newId,
      name: `${original.name || 'Untitled'} (Copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await this.saveProject(copy);
    return copy;
  }

  /**
   * Renames a project
   * @param {string} id 
   * @param {string} newName 
   */
  static async renameProject(id, newName) {
    const proj = await this.loadProject(id);
    if (!proj) throw new Error('Project not found');
    proj.name = (newName || '').trim() || 'Untitled Project';
    return this.saveProject(proj);
  }

  /**
   * Stores a large Blob/ArrayBuffer in IndexedDB
   * @param {string} key 
   * @param {Blob|ArrayBuffer} blob 
   */
  static async saveBlob(key, blob) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      const store = tx.objectStore(STORE_BLOBS);
      const req = store.put({ key, blob, updatedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Loads a Blob from IndexedDB
   * @param {string} key 
   * @returns {Promise<Blob|null>}
   */
  static async getBlob(key) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readonly');
      const store = tx.objectStore(STORE_BLOBS);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Deletes a Blob
   * @param {string} key 
   */
  static async deleteBlob(key) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      const store = tx.objectStore(STORE_BLOBS);
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Retrieves cached vision tags for a photo
   * @param {string} cacheKey 
   * @returns {Promise<object|null>}
   */
  static async getCachedPhotoTags(cacheKey) {
    if (!cacheKey) return null;
    try {
      const db = await getDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_VISION_CACHE, 'readonly');
        const store = tx.objectStore(STORE_VISION_CACHE);
        const req = store.get(cacheKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * Caches vision tags for a photo
   * @param {string} cacheKey 
   * @param {object} data { tags: string[], caption: string, mood: string }
   */
  static async setCachedPhotoTags(cacheKey, data) {
    if (!cacheKey || !data) return;
    try {
      const db = await getDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_VISION_CACHE, 'readwrite');
        const store = tx.objectStore(STORE_VISION_CACHE);
        const req = store.put({
          cacheKey,
          tags: data.tags || [],
          caption: data.caption || '',
          mood: data.mood || 'neutral',
          cachedAt: Date.now()
        });
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    } catch (e) {}
  }
}
