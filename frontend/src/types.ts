export interface Algorithm {
  className: string
  displayName: string
}

export interface JsonSchemaProperty {
  type?: string
  id?: string
  $ref?: string
  title?: string
  description?: string
  enum?: string[]
  properties?: Record<string, JsonSchemaProperty>
  additionalProperties?: boolean | JsonSchemaProperty
  items?: JsonSchemaProperty
  required?: string[]
  minimum?: number
  maximum?: number
}

export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  description?: string
}

export interface SavedTest {
  id: number
  name: string
  algorithm: string
  display_name: string
  config: string
  input: string
  key_value: string
  output: string | null
  created_at: string
  updated_at: string
}

export interface MaskResult {
  output?: string
  error?: string
}

export type View = 'welcome' | 'tester' | 'saved' | 'settings'

export interface ServerFile {
  name: string
  uri: string
  size: number
  updatedAt: string
}

export type Locale = 'en' | 'pt-BR' | 'es'

/** What the user picked in Settings: an explicit locale, or browser detection. */
export type LocalePref = Locale | 'auto'

export interface AppConfig {
  filesDir: string
  locale: LocalePref
}

export interface AiStatus {
  provider: string
  model: string
  baseUrl: string
  ok: boolean
  error?: string
  models?: string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** An algorithm the assistant built, validated by running it, and saved. */
export interface SavedAlgorithm {
  id: number
  name: string
  className: string
  displayName: string
  input: string
  output: string | null
}

export interface ChatHandlers {
  onDelta: (delta: string) => void
  /** Final text with the save block stripped out. */
  onReplace: (text: string) => void
  onSaved: (saved: SavedAlgorithm) => void
  onSaveError: (message: string) => void
  onError: (message: string) => void
}
