import { useState } from 'react'
import { PackageOpen, RefreshCw, ExternalLink, Copy, Check } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const SDK_DOC = 'https://portal.perforce.com/s/article/Compliance-Algorithm-SDK-for-Guidewire-1728062704114'

/**
 * Shown instead of the app when the Delphix libraries are missing. Without them there are no
 * algorithms to list and nothing to run, so an empty sidebar was all the user used to get — no
 * message, no idea what was wrong. This says what is missing, where it goes and how to get it.
 */
export function SetupNeeded({ missing, libDir, onRetry }: {
  missing: string[]
  libDir: string
  onRetry: () => Promise<void> | void
}) {
  const { t, tx } = useT()
  const [checking, setChecking] = useState(false)
  const [copied, setCopied] = useState(false)

  const retry = async () => {
    setChecking(true)
    try { await onRetry() } finally { setChecking(false) }
  }

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(libDir)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-2">
          <span className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0">
            <PackageOpen size={20} className="text-amber-700" />
          </span>
          <h1 className="text-xl font-semibold text-slate-800">{t('setup.title')}</h1>
        </div>
        <p className="text-sm text-slate-600 mb-6">{t('setup.lede')}</p>

        <ol className="space-y-4">
          <li className="bg-white rounded-xl border border-slate-200 p-5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              {t('setup.step1')}
            </p>
            <p className="text-sm text-slate-700">
              {tx('setup.step1Body', {
                link: (
                  <a href={SDK_DOC} target="_blank" rel="noreferrer"
                     className="text-blue-600 hover:underline inline-flex items-center gap-1">
                    {t('setup.sdkDoc')}<ExternalLink size={11} />
                  </a>
                ),
              })}
            </p>
          </li>

          <li className="bg-white rounded-xl border border-slate-200 p-5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              {t('setup.step2')}
            </p>
            <p className="text-sm text-slate-700 mb-2.5">{t('setup.step2Body')}</p>
            <button
              onClick={copyPath}
              title={t('setup.copyPath')}
              className="w-full flex items-center gap-2 text-left font-mono text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 hover:border-blue-300 transition-colors"
            >
              <span className="flex-1 break-all">{libDir}</span>
              {copied
                ? <Check size={13} className="text-green-600 flex-shrink-0" />
                : <Copy size={13} className="text-slate-400 flex-shrink-0" />}
            </button>
          </li>

          <li className="bg-white rounded-xl border border-slate-200 p-5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              {t('setup.missingTitle', { n: missing.length })}
            </p>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              {missing.map(prefix => (
                <li key={prefix} className="font-mono text-xs text-slate-600 break-all">
                  {prefix}<span className="text-slate-400">*.jar</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-400 mt-3">{t('setup.versionsHint')}</p>
          </li>
        </ol>

        <button
          onClick={retry}
          disabled={checking}
          className="mt-6 flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          <RefreshCw size={15} className={cn(checking && 'animate-spin')} />
          {checking ? t('setup.checking') : t('setup.recheck')}
        </button>

        <p className="text-xs text-slate-400 mt-6">{t('setup.independence')}</p>
      </div>
    </div>
  )
}
