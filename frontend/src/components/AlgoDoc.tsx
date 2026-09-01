import { useEffect, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { loadGuide, type GuideEntry } from '@/lib/algo-guide'
import { cn } from '@/lib/utils'

/** Colours mirror the guide's own tag palette (docs/src/guide.css). */
const TAG_STYLE: Record<string, string> = {
  'tag-det': 'bg-[#e6f0f5] text-[#0b4f6c]',
  'tag-rev': 'bg-[#eaf2ee] text-[#2c5f4a]',
  'tag-warn': 'bg-[#fbf3e6] text-[#8a5410]',
  'tag-file': 'bg-slate-100 text-slate-600',
  'tag-nondet': 'bg-[#fbf3e6] text-[#8a5410] ring-1 ring-[#8a5410]',
}

/**
 * The Documentation tab. The content is the algorithm's section from the reference guide
 * in docs/src/ — the very same source the PDFs are generated from, so the two cannot
 * disagree. The HTML is project content read at build time, never user input.
 */
export function AlgoDoc({ className }: { className: string }) {
  const { t, locale } = useT()
  // Keyed by locale+algorithm so "still loading" is derived from the state itself,
  // rather than flipping a loading flag from inside the effect.
  const key = `${locale}|${className}`
  const [loaded, setLoaded] = useState<{ key: string; entry: GuideEntry | null } | null>(null)

  useEffect(() => {
    let alive = true
    loadGuide(locale).then(guide => {
      if (alive) setLoaded({ key, entry: guide[className] ?? null })
    })
    return () => { alive = false }
  }, [key, className, locale])

  if (loaded?.key !== key) {
    return <p className="text-sm text-slate-400 p-5">{t('tester.docLoading')}</p>
  }

  const entry = loaded.entry
  if (!entry) {
    return (
      <div className="p-5">
        <p className="text-sm text-slate-500">{t('tester.docMissing')}</p>
      </div>
    )
  }

  return (
    <article className="algo-doc bg-white rounded-xl border border-slate-200 shadow-sm p-6 max-w-4xl">
      <header className="mb-5 pb-4 border-b border-slate-100">
        <div className="flex items-baseline gap-2.5">
          <span className="text-xs font-semibold text-slate-400 tabular-nums">{entry.number}</span>
          <h3 className="text-lg font-semibold text-slate-800">{entry.title}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <span className="text-[11px] font-mono text-slate-400">{entry.className}</span>
          {entry.tags.map(tag => (
            <span
              key={tag.kind + tag.label}
              className={cn(
                'text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded',
                TAG_STYLE[tag.kind] ?? 'bg-slate-100 text-slate-600'
              )}
            >
              {tag.label}
            </span>
          ))}
        </div>
      </header>

      <div dangerouslySetInnerHTML={{ __html: entry.body }} />

      <footer className="mt-6 pt-4 border-t border-slate-100 flex items-center gap-1.5 text-xs text-slate-400">
        <BookOpen size={12} />
        {t('tester.docSource')}
      </footer>
    </article>
  )
}
