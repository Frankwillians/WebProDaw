/**
 * Persistent sample store.
 *
 * The project JSON in localStorage only carries clip metadata; the actual
 * audio (imported files and recorded takes) lives here, in IndexedDB, as
 * 16-bit WAV blobs keyed by a stable bufferId stored on each track.
 */

const DB_NAME = 'webdaw-samples'
const DB_VERSION = 1
const STORE = 'clips'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB bloqueado por outra aba'))
  })
  // A promise that failed once must not be the answer for the rest of the
  // session: a closed database, a blocked open, a full disk all arrive as one
  // rejection, and caching it would leave every later clip permanently silent.
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = run(tx.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.onabort = () => reject(tx.error ?? new Error('transação abortada'))
  })
}

/**
 * Writes in flight, per sample id.
 *
 * The clip's metadata is published the moment a take or an imported file is
 * decoded, while the bytes are still on their way to IndexedDB. Without this
 * ledger, the first reader — the plugin preview, the bounce, the meter — asks
 * for a blob that exists but has not landed, and reports "o áudio do clipe não
 * está no armazenamento" about audio that is fine.
 */
const pendingWrites = new Map<string, Promise<void>>()

export async function saveSample(id: string, blob: Blob): Promise<void> {
  if (!id) return
  // Two writes for the same id go in order; the second holds the real bytes.
  const before = pendingWrites.get(id) ?? Promise.resolve()
  const write = before
    .catch(() => undefined)
    .then(() =>
      withStore('readwrite', (store) => store.put({ id, savedAt: Date.now(), blob })).then(
        () => undefined,
      ),
    )
    .catch(() => {
      /* storage unavailable — the clip simply will not survive a reload */
    })
  pendingWrites.set(id, write)
  try {
    await write
  } finally {
    if (pendingWrites.get(id) === write) pendingWrites.delete(id)
  }
}

/** Wait for the bytes a caller has already been promised, without hanging. */
async function settlePending(id: string): Promise<void> {
  const inflight = pendingWrites.get(id)
  if (!inflight) return
  await Promise.race([inflight, new Promise<void>((resolve) => window.setTimeout(resolve, 8000))])
}

export async function loadSample(id: string): Promise<Blob | null> {
  if (!id) return null
  await settlePending(id)
  try {
    const record = await withStore<{ id: string; blob: Blob } | undefined>(
      'readonly',
      (store) => store.get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>,
    )
    return record?.blob ?? null
  } catch {
    return null
  }
}

export async function deleteSample(id: string): Promise<void> {
  if (!id) return
  // A write still queued for this id would put the bytes back after the delete.
  await settlePending(id)
  pendingWrites.delete(id)
  try {
    await withStore('readwrite', (store) => store.delete(id))
  } catch {
    /* ignore */
  }
}

export async function clearSamples(): Promise<void> {
  await Promise.allSettled([...pendingWrites.values()])
  pendingWrites.clear()
  try {
    await withStore('readwrite', (store) => store.clear())
  } catch {
    /* ignore */
  }
}

/**
 * Every stored clip, for bundling a project into a file. Blobs the project no
 * longer references are deliberately left behind rather than deleted here - the
 * caller owns the decision about what is orphaned.
 */
export async function listSamples(): Promise<Array<{ id: string; blob: Blob }>> {
  await Promise.allSettled([...pendingWrites.values()])
  try {
    const records = await withStore<Array<{ id: string; blob: Blob }>>(
      'readonly',
      (store) => store.getAll() as IDBRequest<Array<{ id: string; blob: Blob }>>,
    )
    return records.filter((record) => record && typeof record.id === 'string' && record.blob)
  } catch {
    return []
  }
}
