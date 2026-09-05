/**
 * The little of IndexedDB this app needs, as promises.
 *
 * Deliberately generic and deliberately tiny: `idb` is a dependency, and
 * CLAUDE.md section 6 forbids adding one without asking. Nothing here knows
 * what a punch is.
 *
 * IndexedDB rather than localStorage because a punch carries a photo of up to a
 * megabyte. localStorage stores strings, so a photo would have to be base64'd —
 * a third larger, synchronous on the main thread, and against a quota measured
 * in single-digit megabytes for the whole origin. IndexedDB stores the Blob
 * itself, by structured clone, with no re-encoding.
 */

/** Rejections carry the underlying `DOMException`, which names the real fault. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('The IndexedDB request failed with no reason given.'));
    };
  });
}

export function openDatabase(
  name: string,
  version: number,
  upgrade: (database: IDBDatabase) => void,
  /**
   * Called when this connection stops being usable, so a caller that caches it
   * can throw the cache away. Without it a closed connection is kept for ever
   * and every later transaction fails with `InvalidStateError` — which for this
   * app means a punch that cannot be queued.
   */
  onClosed: () => void = () => undefined,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = () => {
      upgrade(request.result);
    };

    request.onsuccess = () => {
      // Without this, a tab left open on an old build blocks every other tab
      // from ever upgrading the schema, and the block is silent.
      request.result.onversionchange = () => {
        request.result.close();
        onClosed();
      };
      request.result.onclose = () => {
        onClosed();
      };
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error(`Could not open the "${name}" database.`));
    };

    request.onblocked = () => {
      reject(
        new Error(
          `Another tab is holding an older version of the "${name}" database open. Close it and reload.`,
        ),
      );
    };
  });
}

/**
 * Runs `work` inside one transaction and resolves when the transaction itself
 * completes.
 *
 * Waiting on `transaction.oncomplete` rather than on the last request is the
 * whole point: a request can succeed and the transaction can still abort, and
 * resolving early would report a queued punch as durable before it was written.
 */
export async function inTransaction<T>(
  database: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(storeName, mode);
  const settled = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('The IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('The IndexedDB transaction was aborted.'));
    };
  });

  const result = await work(transaction.objectStore(storeName));
  await settled;
  return result;
}

export const idbGetAll = (store: IDBObjectStore): Promise<unknown[]> =>
  promisify<unknown[]>(store.getAll());

export const idbGet = (store: IDBObjectStore, key: IDBValidKey): Promise<unknown> =>
  promisify<unknown>(store.get(key));

/** `add` rather than `put`: a duplicate key must fail loudly, not overwrite. */
export const idbAdd = (store: IDBObjectStore, value: unknown): Promise<IDBValidKey> =>
  promisify(store.add(value));

export const idbPut = (store: IDBObjectStore, value: unknown): Promise<IDBValidKey> =>
  promisify(store.put(value));

export const idbDelete = (store: IDBObjectStore, key: IDBValidKey): Promise<undefined> =>
  promisify(store.delete(key));
