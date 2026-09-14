import { ShieldCheck, PanelLeftOpen, Boxes, X } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { Chat } from './Chat'

interface Props {
  onOpenSidebar: () => void
  onOpenAlgorithm: (id: number) => void
  onOpenSettings: () => void
  /** Arrived here from "New algorithm": say where an algorithm actually starts. */
  pickFramework?: boolean
  onDismissPick?: () => void
}

export function WelcomeScreen({
  onOpenSidebar, onOpenAlgorithm, onOpenSettings, pickFramework = false, onDismissPick,
}: Props) {
  const { t } = useT()
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-200 bg-white flex-shrink-0">
        <button onClick={onOpenSidebar} className="text-slate-400 hover:text-slate-600 transition-colors md:hidden">
          <PanelLeftOpen size={18} />
        </button>
        <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
          <ShieldCheck size={16} className="text-blue-600" />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-slate-800 truncate">{t('welcome.title')}</h1>
          <p className="text-xs text-slate-400 truncate">{t('welcome.subtitle')}</p>
        </div>
      </div>

      {/* The sidebar has just opened Frameworks; this says why, and names the other way in — the
          assistant is right underneath, and it builds an algorithm out of a description. */}
      {pickFramework && (
        <div className="px-5 pt-4 flex-shrink-0">
          <div className="flex gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
            <Boxes size={16} className="text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-blue-900">{t('welcome.pickTitle')}</p>
              <p className="text-sm text-blue-800 mt-1">{t('welcome.pickBody')}</p>
            </div>
            <button
              onClick={onDismissPick}
              title={t('welcome.pickDismiss')}
              className="text-blue-400 hover:text-blue-700 transition-colors flex-shrink-0"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 p-5">
        <Chat onOpenAlgorithm={onOpenAlgorithm} onOpenSettings={onOpenSettings} />
      </div>
    </div>
  )
}
