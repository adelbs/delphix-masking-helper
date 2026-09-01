import { ShieldCheck, PanelLeftOpen } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { Chat } from './Chat'

interface Props {
  onOpenSidebar: () => void
  onShowSaved: () => void
  onOpenSettings: () => void
}

export function WelcomeScreen({ onOpenSidebar, onShowSaved, onOpenSettings }: Props) {
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

      <div className="flex-1 min-h-0 p-5">
        <Chat onShowSaved={onShowSaved} onOpenSettings={onOpenSettings} />
      </div>
    </div>
  )
}
