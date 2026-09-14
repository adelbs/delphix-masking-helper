import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import type { ClassifierCatalog } from '@/types'
import type { FieldFormState } from '@/lib/field-form'

const FAMILY_ORDER = ['text', 'number', 'date', 'timestamp', 'binary', 'boolean', 'other']
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const k = (key: string) => key as MessageKey

const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5'
const helpCls = 'text-xs text-slate-400 mt-1'
const fieldCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

/** The inputs for that description. Its state comes from `useFieldForm`. */
export function FieldForm({ form, catalog }: { form: FieldFormState; catalog: ClassifierCatalog | null }) {
  const { t } = useT()

  const sqlTypes = [...(catalog?.sqlTypes ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  // Grouped by family in the order people reach for them; any family the server adds goes last.
  const families = [
    ...FAMILY_ORDER.filter(f => sqlTypes.some(s => s.family === f)),
    ...[...new Set(sqlTypes.map(s => s.family))].filter(f => !FAMILY_ORDER.includes(f)),
  ]

  return (
    <>
      <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2">
        <p className="text-xs font-semibold text-slate-600">{t('classifier.columnSection')}</p>
        <p className="text-xs text-slate-500 mt-0.5">{t('classifier.columnSectionHint')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>{t('classifier.fieldName')}</label>
          <input type="text" value={form.name} onChange={e => form.setName(e.target.value)}
                 placeholder={t('classifier.fieldNamePlaceholder')} className={cn(fieldCls, 'font-mono')} />
          <p className={helpCls}>{t('classifier.fieldNameHint')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('classifier.parent')}</label>
          <input type="text" value={form.parent} onChange={e => form.setParent(e.target.value)}
                 placeholder={t('classifier.parentPlaceholder')} className={cn(fieldCls, 'font-mono')} />
          <p className={helpCls}>{t('classifier.parentHint')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('classifier.sqlType')}</label>
          <select value={form.sqlType} onChange={e => form.setSqlType(Number(e.target.value))}
                  disabled={!sqlTypes.length} className={fieldCls}>
            {!sqlTypes.length && <option value={form.sqlType}>{t('classifier.loadingCatalog')}</option>}
            {families.map(family => (
              <optgroup key={family} label={capitalize(t(k(`classifier.family.${family}`)))}>
                {sqlTypes.filter(s => s.family === family).map(s => (
                  <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className={helpCls}>{t('classifier.sqlTypeHint')}</p>
        </div>
        <div>
          <label className={labelCls}>{t('classifier.length')}</label>
          <input type="number" min={0} value={form.length} onChange={e => form.setLength(e.target.value)}
                 placeholder={t('classifier.lengthPlaceholder')} className={fieldCls} />
          <p className={helpCls}>{t('classifier.lengthHint')}</p>
        </div>
      </div>

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={form.autoIncrement}
               onChange={e => form.setAutoIncrement(e.target.checked)} />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-slate-700">{t('classifier.autoIncrement')}</span>
          <span className={cn(helpCls, 'block')}>{t('classifier.autoIncrementHint')}</span>
        </span>
      </label>

      <div>
        <label className={labelCls}>{t('classifier.values')}</label>
        <textarea rows={6} value={form.values} onChange={e => form.setValues(e.target.value)}
                  placeholder={t('classifier.valuesPlaceholder')} spellCheck={false}
                  className={cn(fieldCls, 'font-mono')} />
        <p className={helpCls}>{t('classifier.valuesHint')}</p>
      </div>
    </>
  )
}
