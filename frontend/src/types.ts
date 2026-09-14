/** A masking framework the plugin provides — the technique, before any configuration. */
export interface Framework {
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

/** A framework configured and named — what Delphix calls an algorithm. */
export interface Algorithm {
  id: number
  name: string
  framework: string
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

export type View = 'welcome' | 'tester' | 'domain' | 'classifier' | 'settings'

export interface ServerFile {
  name: string
  uri: string
  size: number
  updatedAt: string
}

/**
 * A sensitive-data domain: a name and two algorithm references, which is the whole of the
 * engine's own Domain object. The two codes are algorithm *names*, and may name a built-in
 * the engine has and this machine does not.
 */
export interface Domain {
  id: number
  name: string
  default_algorithm: string
  default_tokenization: string
  delphix_origin: string | null
  created_at: string
  updated_at: string
}

export type ClassifierFrameworkName = 'PATH' | 'TYPE' | 'REGEX' | 'LIST'

/**
 * A classifier: one framework's configuration, voting for one domain. PATH and TYPE read a
 * column's metadata, REGEX and LIST a sample of its values. The name is unique but, unlike a
 * domain's, can be changed on the engine; the framework cannot.
 */
export interface Classifier {
  id: number
  name: string
  framework: ClassifierFrameworkName
  domain_name: string
  description: string
  config: Record<string, unknown>
  /** classifierId on the engine it came from or was sent to. */
  delphix_id: number | null
  delphix_origin: string | null
  created_at: string
  updated_at: string
}

/** One setting of a framework, as the configuration form renders it. */
export interface ClassifierField {
  key: string
  kind: 'text' | 'choice' | 'integer' | 'number' | 'flag' | 'file'
  required?: boolean
  fallback?: string | number | boolean
  options?: string[]
  /** Values outside `options` are kept — Delphix knows them — but cannot be evaluated here. */
  openEnded?: boolean
  min?: number
  max?: number
  maxChars?: number
}

export interface ClassifierFrameworkSpec {
  reads: 'metadata' | 'values'
  /** The repeated entries: paths, allowed types, patterns or value lists. */
  list: { key: string; fields: ClassifierField[] }
  /** Settings for the classifier as a whole. */
  settings: ClassifierField[]
}

export interface SqlTypeInfo {
  code: number
  name: string
  family: string
}

export interface ClassifierCatalog {
  frameworks: Record<ClassifierFrameworkName, ClassifierFrameworkSpec>
  sqlTypes: SqlTypeInfo[]
}

/** A problem in a configuration. `code` is translated; `message` is the English fallback. */
export interface ClassifierIssue {
  severity: 'error' | 'limitation' | 'hint'
  code: string
  where: { list?: string; index?: number; field?: string }
  params: Record<string, string | number>
  message: string
}

export interface ClassifierReview {
  /** Delphix would refuse the configuration. */
  errors: ClassifierIssue[]
  /** Delphix accepts it, but it cannot be tested here. */
  limitations: ClassifierIssue[]
  /** Accepted, but probably not what was meant. */
  hints: ClassifierIssue[]
}

/** A column as profiling meets it. */
export interface ClassifierTestField {
  name: string
  parent?: string
  sqlType?: number
  /** Length or precision; null when unknown. */
  length?: number | null
  autoIncrement?: boolean
  values: string[]
}

export type ClassifierOutcome =
  | 'counted' | 'merged' | 'duplicate' | 'weaker' | 'no-values' | 'ruled-out' | 'decided' | 'failed'

export interface ClassifierValueRow {
  value: string
  score: number
  pattern?: number | null
  checksumFailed?: number[]
  list?: number | null
  words?: Array<{ word: string; list: number | null }>
}

export interface ClassifierReport {
  id: number | string | null
  name: string
  domain: string
  framework: ClassifierFrameworkName
  reads: 'metadata' | 'values'
  outcome: ClassifierOutcome
  score: number | null
  hits: number
  explain?: {
    rule?: number | null
    accepted?: string
    rejected?: string
    rows?: ClassifierValueRow[]
  }
  lists?: Array<{ file: string; size: number }>
  problem?: string
}

export interface ClassifierDomainScore {
  domain: string
  score: number
  percent: number
  metadata: { classifier: string; score: number } | null
  values: { classifier: string; score: number; hits: number } | null
  /** Whether each kind counted — one within a thousandth of zero is left out of the blend. */
  counted: { metadata: boolean; values: boolean }
}

export interface ClassifierTestResult {
  column: {
    name: string
    parent: string | null
    sqlType: number
    family: string
    length: number
    autoIncrement: boolean
  }
  sampleSize: number
  valuesSkipped: 'decided-by-metadata' | 'no-values' | 'no-value-classifiers' | null
  decisiveDomain: string | null
  classifiers: ClassifierReport[]
  mergedTypes: Array<{ name: string; domain: string; from: string[]; score: number }>
  ranking: ClassifierDomainScore[]
  top: ClassifierDomainScore[]
  assigned: string
  threshold: number
  /** Saved classifiers of the domain left out because they cannot take part. */
  skipped: Array<{ name: string; error: string }>
  /** Set instead of a ranking when a classifier the column needs cannot be evaluated here. */
  failure?: string
}

/** Names the configured engine holds, offered by fields that reference an algorithm or domain. */
export interface EngineReferences {
  state: 'loading' | 'ready' | 'not-configured' | 'unavailable'
  algorithms: string[]
  /** The algorithms the engine reports as able to tokenize — all a domain's tokenization field takes. */
  tokenization: string[]
  domains: string[]
  error?: string
}

/** The plugin's built-in algorithms, as reference fields offer them. */
export interface BuiltinReferences {
  algorithms: string[]
  /** The built-ins able to tokenize and re-identify. */
  tokenization: string[]
  /** Framework classes whose algorithms can — how a saved algorithm is judged. */
  tokenizationFrameworks: string[]
}

/** What build this is, resolved by the server at startup from the git tag. */
export interface VersionInfo {
  /** What to show: "v1.0.3", "v1.0.3-5-ga05aca3", or the package.json version with no git. */
  display: string | null
  commit: string | null
  channel: 'release' | 'dev' | 'unknown'
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
  /** The startup read of the catalog into a local model — minutes of silence, with a name. */
  warm?: {
    state: 'idle' | 'warming' | 'ready' | 'failed'
    model: string | null
    elapsedSec: number | null
    seconds: number | null
    error: string | null
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** An algorithm the assistant built, validated by running it, and saved. */
export interface AssistantAlgorithm {
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
  onSaved: (saved: AssistantAlgorithm) => void
  onSaveError: (message: string) => void
  onError: (message: string) => void
}
