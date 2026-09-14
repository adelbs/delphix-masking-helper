import { useCallback, useState } from 'react'
import type { ImportProgress } from '@/lib/engine-sync'

/** An import's progress, with the furthest the bar has been allowed to reach. */
export type ImportReached = ImportProgress & { percent: number }

/**
 * Holds where an import has got to, for the three import dialogs.
 *
 * The total is not known when an import starts — each object drags down what it references, so
 * the work is discovered as it goes and the total grows. The percentage is therefore kept as the
 * furthest it has reached: without that the bar would slide backwards the moment a domain
 * brought three algorithms along. The counter the bar shows is the honest one, and it is right
 * there beside it.
 */
export function useImportProgress() {
  const [progress, setProgress] = useState<ImportReached | null>(null)

  const report = useCallback((p: ImportProgress) => setProgress(far => {
    const percent = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
    return { ...p, percent: Math.max(far?.percent ?? 0, percent) }
  }), [])

  const clear = useCallback(() => setProgress(null), [])

  return { progress, report, clear }
}
