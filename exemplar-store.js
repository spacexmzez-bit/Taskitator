/* exemplar-store.js */
/**
 * Taskitator - Exemplar Reference Storage Engine
 * Manages client-side binary exemplar storage in IndexedDB.
 * Completely decoupled from localStorage and Cloudflare KV sync engine.
 */

(function (window) {
    'use strict';

    const DB_NAME = 'TaskitatorExemplarDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'exemplars';
    const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB ceiling

    let dbInstance = null;

    /**
     * Initializes or retrieves the singleton IndexedDB connection.
     * @returns {Promise<IDBDatabase>}
     */
    function getDB() {
        if (dbInstance) return Promise.resolve(dbInstance);

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'taskId' });
                }
            };

            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                resolve(dbInstance);
            };

            request.onerror = (event) => {
                console.error('[ExemplarStore] Database initialization error:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    /**
     * Converts a File or Blob into a base64 encoded string.
     * @param {Blob} blob 
     * @returns {Promise<string>} Pure base64 data without data-URL prefix.
     */
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = reader.result;
                if (typeof result === 'string') {
                    const base64Data = result.split(',')[1] || '';
                    resolve(base64Data);
                } else {
                    reject(new Error('Failed to parse file to Base64 string.'));
                }
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    const ExemplarStore = {
        MAX_FILE_SIZE_BYTES,

        /**
         * Persists an exemplar document/image for an active task.
         * Enforces the hard 5 MB size limit before storage.
         * @param {string} taskId 
         * @param {Blob|File} file 
         * @returns {Promise<{success: boolean, message?: string}>}
         */
        async saveExemplar(taskId, file) {
            if (!taskId) throw new Error('Task ID is required to save an exemplar.');
            if (!file) throw new Error('No file provided for exemplar storage.');

            if (file.size > MAX_FILE_SIZE_BYTES) {
                throw new Error(`File exceeds maximum size of 5 MB (${(file.size / (1024 * 1024)).toFixed(2)} MB).`);
            }

            const db = await getDB();
            const record = {
                taskId: String(taskId),
                blob: file,
                mimeType: file.type || 'application/octet-stream',
                fileName: file.name || 'reference_exemplar',
                fileSize: file.size,
                savedAt: new Date().toISOString()
            };

            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.put(record);

                request.onsuccess = () => resolve({ success: true });
                request.onerror = (event) => {
                    console.error('[ExemplarStore] Failed to save record:', event.target.error);
                    reject(event.target.error);
                };
            });
        },

        /**
         * Fast boolean check to confirm if an exemplar exists for a given task ID.
         * @param {string} taskId 
         * @returns {Promise<boolean>}
         */
        async hasExemplar(taskId) {
            if (!taskId) return false;
            const db = await getDB();

            return new Promise((resolve) => {
                const transaction = db.transaction([STORE_NAME], 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.count(IDBKeyRange.only(String(taskId)));

                request.onsuccess = () => resolve(request.result > 0);
                request.onerror = () => resolve(false);
            });
        },

        /**
         * Retrieves an exemplar and formats it as an inline Gemini multimodal payload.
         * @param {string} taskId 
         * @returns {Promise<{taskId: string, mimeType: string, fileName: string, inlineData: {mimeType: string, data: string}}|null>}
         */
        async getExemplar(taskId) {
            if (!taskId) return null;
            const db = await getDB();

            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_NAME], 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(String(taskId));

                request.onsuccess = async () => {
                    const record = request.result;
                    if (!record || !record.blob) {
                        resolve(null);
                        return;
                    }

                    try {
                        const base64Data = await blobToBase64(record.blob);
                        resolve({
                            taskId: record.taskId,
                            mimeType: record.mimeType,
                            fileName: record.fileName,
                            fileSize: record.fileSize,
                            inlineData: {
                                mimeType: record.mimeType,
                                data: base64Data
                            }
                        });
                    } catch (err) {
                        console.error('[ExemplarStore] Base64 encoding error:', err);
                        reject(err);
                    }
                };

                request.onerror = (event) => {
                    console.error('[ExemplarStore] Failed to retrieve record:', event.target.error);
                    reject(event.target.error);
                };
            });
        },

        /**
         * Immediately and permanently deletes an exemplar record.
         * Invoked immediately when a task is completed, deleted, or wiped.
         * @param {string} taskId 
         * @returns {Promise<boolean>}
         */
        async deleteExemplar(taskId) {
            if (!taskId) return false;
            const db = await getDB();

            return new Promise((resolve) => {
                const transaction = db.transaction([STORE_NAME], 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.delete(String(taskId));

                request.onsuccess = () => resolve(true);
                request.onerror = (event) => {
                    console.warn('[ExemplarStore] Failed to delete exemplar:', event.target.error);
                    resolve(false);
                };
            });
        },

        /**
         * Clears all exemplar files from IndexedDB.
         * Invoked during factory reset or full storage cleanup.
         * @returns {Promise<boolean>}
         */
        async clearAll() {
            const db = await getDB();
            return new Promise((resolve) => {
                const transaction = db.transaction([STORE_NAME], 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.clear();

                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            });
        }
    };

    window.ExemplarStore = ExemplarStore;

})(window);
