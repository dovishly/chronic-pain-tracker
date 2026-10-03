// Promise wrapper around the on-device IndexedDB database.
// Stores: trackers and entries (keyed by id), outbox (writes waiting to sync, keyed "table:id"),
// and meta (small key/value records such as sync cursors).

export type StoreName = 'trackers' | 'entries' | 'outbox' | 'meta';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('logbook', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('trackers', { keyPath: 'id' });
      database.createObjectStore('entries', { keyPath: 'id' });
      database.createObjectStore('outbox', { keyPath: 'key' });
      database.createObjectStore('meta', { keyPath: 'k' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return opening;
}

/** Runs fn(objectStore) in a transaction and resolves with fn's result once the transaction commits. */
async function inTransaction<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => T | Promise<T>,
): Promise<T> {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    let result: T;
    Promise.resolve(fn(transaction.objectStore(storeName))).then(value => { result = value; });
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Turns an IDBRequest into a promise for its result. */
const settled = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const db = {
  all: <T>(storeName: StoreName) => inTransaction(storeName, 'readonly', store => settled(store.getAll() as IDBRequest<T[]>)),
  get: <T>(storeName: StoreName, key: string) => inTransaction(storeName, 'readonly', store => settled(store.get(key) as IDBRequest<T | undefined>)),
  put: (storeName: StoreName, value: unknown) => inTransaction(storeName, 'readwrite', store => { store.put(value); }),
  putMany: (storeName: StoreName, values: unknown[]) => inTransaction(storeName, 'readwrite', store => { values.forEach(v => store.put(v)); }),
  remove: (storeName: StoreName, key: string) => inTransaction(storeName, 'readwrite', store => { store.delete(key); }),
  clear: (storeName: StoreName) => inTransaction(storeName, 'readwrite', store => { store.clear(); }),

  async getMeta<T>(key: string): Promise<T | null> {
    const record = await inTransaction('meta', 'readonly', store => settled(store.get(key) as IDBRequest<{ k: string; v: T } | undefined>));
    return record ? record.v : null;
  },
  setMeta: (key: string, value: unknown) => inTransaction('meta', 'readwrite', store => { store.put({ k: key, v: value }); }),
};
