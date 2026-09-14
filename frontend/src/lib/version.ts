import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { VersionInfo } from '@/types'

/**
 * The build identity, fetched once per page load and shared by every caller.
 *
 * It cannot change while the app is open — the server resolved it at startup — so the promise
 * is cached at module level rather than threaded through props to the four places that show
 * it (sidebar footer, Settings, the setup screen, and any future one).
 */
let pending: Promise<VersionInfo | null> | null = null

function load(): Promise<VersionInfo | null> {
  // A version we could not read is not worth an error: the rest of the app works without it.
  pending ??= api.getVersion().catch(() => null)
  return pending
}

/** Returns null while loading, and stays null if the server could not say. */
export function useVersion(): VersionInfo | null {
  const [version, setVersion] = useState<VersionInfo | null>(null)
  useEffect(() => {
    let live = true
    load().then(v => { if (live) setVersion(v) })
    return () => { live = false }
  }, [])
  return version
}
