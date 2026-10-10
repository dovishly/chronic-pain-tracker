// IndexedDB stores: trackers and entries (by id), outbox (writes waiting to sync, by "table:id"), meta (key/value).

export type StoreName = 'trackers' | 'entries' | 'outbox' | 'meta';

/** One function per database version. Append to change the database; never edit one, since devices may be on any older version. */
const UPGRADES: ((database: IDBDatabase, transaction: IDBTransaction) => void)[] = [
  database => {
    database.createObjectStore('trackers', { keyPath: 'id' });
    database.createObjectStore('entries', { keyPath: 'id' });
    database.createObjectStore('outbox', { keyPath: 'key' });
    database.createObjectStore('meta', { keyPath: 'key' });
  },
];

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    // "logbook" is Log Lightly's former name, kept so what devices have saved still opens.
    const request = indexedDB.open('logbook', UPGRADES.length);
    request.onupgradeneeded = event => {
      for (let version = event.oldVersion; version < UPGRADES.length; version++) {
        UPGRADES[version](request.result, request.transaction!);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // A newer version of the app opened in another tab wants to upgrade: step aside and reload into it.
      database.onversionchange = () => {
        database.close();
        location.reload();
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
  return opening;
}

/**
 * Runs fn in one transaction over the named stores, and resolves with fn's result once the transaction commits.
 * If any write in it fails, none of them are saved.
 */
async function inTransaction<T>(
  storeNames: StoreName[],
  mode: IDBTransactionMode,
  fn: (transaction: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeNames, mode);
    let result: T;
    Promise.resolve(fn(transaction)).then(value => { result = value; });
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Runs fn(objectStore) in a transaction of its own. */
const inStore = <T>(storeName: StoreName, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => T | Promise<T>) =>
  inTransaction([storeName], mode, transaction => fn(transaction.objectStore(storeName)));

/** Turns an IDBRequest into a promise for its result. */
const settled = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const db = {
  all: <T>(storeName: StoreName) => inStore(storeName, 'readonly', store => settled(store.getAll() as IDBRequest<T[]>)),
  putMany: (storeName: StoreName, values: unknown[]) => inStore(storeName, 'readwrite', store => { values.forEach(v => store.put(v)); }),
  clear: (storeName: StoreName) => inStore(storeName, 'readwrite', store => { store.clear(); }),

  /** Puts values into several stores in one transaction: all of them are saved, or none are. */
  putTogether: (values: Partial<Record<StoreName, unknown[]>>) =>
    inTransaction(Object.keys(values) as StoreName[], 'readwrite', transaction => {
      for (const [storeName, items] of Object.entries(values)) items?.forEach(v => transaction.objectStore(storeName).put(v));
    }),

  /** Removes each key whose stored value passes test, in one transaction. Resolves with the keys it removed. */
  removeIf: <T>(storeName: StoreName, keys: string[], test: (value: T | undefined, key: string) => boolean) =>
    inStore(storeName, 'readwrite', store => {
      const removed: string[] = [];
      for (const key of keys) {
        const request = store.get(key) as IDBRequest<T | undefined>;
        request.onsuccess = () => {
          if (!test(request.result, key)) return;
          store.delete(key);
          removed.push(key);
        };
      }
      return removed;
    }),

  async getMeta<T>(key: string): Promise<T | null> {
    const record = await inStore('meta', 'readonly', store => settled(store.get(key) as IDBRequest<{ key: string; value: T } | undefined>));
    return record ? record.value : null;
  },
  setMeta: (key: string, value: unknown) => inStore('meta', 'readwrite', store => { store.put({ key, value }); }),
};
