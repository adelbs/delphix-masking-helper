import { useState } from 'react'
import type { ClassifierTestField } from '@/types'

/**
 * The column the classifier test profiles: what the catalog says about it — name, table, type,
 * length — and a sample of what it holds.
 *
 * Kept apart from the form that renders it so the state and the markup can each be read on their
 * own; `components/FieldForm.tsx` is the other half.
 */
export function useFieldForm() {
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [sqlType, setSqlType] = useState(12)
  const [length, setLength] = useState('')
  const [autoIncrement, setAutoIncrement] = useState(false)
  const [values, setValues] = useState('')

  const field: ClassifierTestField = {
    name,
    parent: parent || undefined,
    sqlType,
    length: length === '' ? null : Number(length),
    autoIncrement,
    // A blank line is not a value; the profiler ignores empty ones too.
    values: values.trim() === '' ? [] : values.split(/\r?\n/),
  }

  return {
    name, setName, parent, setParent, sqlType, setSqlType,
    length, setLength, autoIncrement, setAutoIncrement, values, setValues,
    field,
  }
}

export type FieldFormState = ReturnType<typeof useFieldForm>
