import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import type { ImportReached } from '@/lib/sync-job'

/**
 * Where a sync is now: what it is on, how far along, and a bar that only moves forward.
 *
 * Without a total — the engine still being listed, or one domain whose algorithms are found as
 * they are sent — there is nothing to measure, so the bar pulses and only the name moves.
 */
export function ImportProgressBar({ progress }: { progress: ImportReached }) {
  const { t } = useT()
  const listing = progress.total === 0

  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 size={12} className="animate-spin flex-shrink-0" />
        <span className="truncate">
          {!progress.name
            ? t('sync.importReading')
            : t(`sync.importStep.${progress.kind}` as MessageKey, { name: progress.name })}
        </span>
        {!listing && (
          <span className="ml-auto flex-shrink-0 tabular-nums">{progress.done}/{progress.total}</span>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
        <div
          className={cn(
            'h-full bg-blue-600 rounded-full',
            // Nothing to measure yet: a sliver that moves, rather than an empty bar.
            listing ? 'w-1/4 animate-pulse' : 'transition-[width] duration-300 ease-out'
          )}
          style={listing ? undefined : { width: `${progress.percent}%` }}
        />
      </div>
    </div>
  )
}
