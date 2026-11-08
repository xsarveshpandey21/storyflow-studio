/**
 * FrameFlow Studio — Storage & Project Persistence Module
 * Safe localStorage wrapper and Project JSON export/import handlers.
 */

const STORAGE_PREFIX = 'frameflow_';

/**
 * Safely saves a JSON-serializable value to localStorage
 * @param {string} key 
 * @param {any} value 
 */
export function saveSetting(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch (err) {
    console.warn('[Storage] Failed to save setting:', key, err);
  }
}

/**
 * Safely loads a value from localStorage
 * @param {string} key 
 * @param {any} defaultValue 
 * @returns {any}
 */
export function loadSetting(key, defaultValue) {
  try {
    if (typeof localStorage === 'undefined') return defaultValue;
    const item = localStorage.getItem(STORAGE_PREFIX + key);
    if (item === null || item === undefined) return defaultValue;
    return JSON.parse(item);
  } catch (err) {
    console.warn('[Storage] Failed to load setting:', key, err);
    return defaultValue;
  }
}

/**
 * Removes a key from localStorage
 * @param {string} key 
 */
export function removeSetting(key) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(STORAGE_PREFIX + key);
  } catch (err) {
    console.warn('[Storage] Failed to remove setting:', key, err);
  }
}

/**
 * Creates and downloads a project .json bundle
 * @param {object} projectData 
 */
export function exportProjectJson(projectData) {
  const jsonStr = JSON.stringify(projectData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `frameflow_project_${timestamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Parses and validates an uploaded project .json file
 * @param {File} file 
 * @returns {Promise<object>}
 */
export function importProjectJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data || typeof data !== 'object') {
          throw new Error('Invalid project file structure.');
        }
        resolve(data);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read project file.'));
    reader.readAsText(file);
  });
}
