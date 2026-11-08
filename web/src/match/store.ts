import type { Company } from '../types'
import sample from '../../../data/sample-companies.json'

/**
 * Local exhibitor store. The bundle lives in IndexedDB so scans work offline
 * after onboarding. Load order: IndexedDB, then the server bundle (if the API
 * is reachable), then the sample list compiled into the app.
 */

const DB_NAME = 'scout'
const STORE = 'bundles'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export const SAMPLE_COMPANIES = sample as Company[]

export interface BundleInfo {
  companies: Company[]
  source: 'indexeddb' | 'server' | 'sample'
}

export async function loadCachedBundle(event: string): Promise<BundleInfo> {
  try {
    const cached = await idbGet<Company[]>(`bundle:${event}`)
    if (cached?.length) return { companies: cached, source: 'indexeddb' }
  } catch {
    /* private mode or IndexedDB unavailable */
  }
  return { companies: SAMPLE_COMPANIES, source: 'sample' }
}

/** Fetch the latest bundle from the API and cache it. Returns null if the API is unreachable. */
export async function refreshBundle(event: string): Promise<Company[] | null> {
  try {
    const res = await fetch(`/api/bundle/${encodeURIComponent(event)}`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    const body = (await res.json()) as { companies: Company[] }
    if (!Array.isArray(body.companies) || !body.companies.length) return null
    await idbPut(`bundle:${event}`, body.companies).catch(() => {})
    return body.companies
  } catch {
    return null
  }
}

export async function cacheCompany(event: string, company: Company, current: Company[]) {
  const next = [...current.filter((c) => c.domain !== company.domain), company]
  await idbPut(`bundle:${event}`, next).catch(() => {})
}
