export declare const LOCALES: readonly ['en', 'pt-BR', 'es']

export interface GuideEntry {
  /** Section number as printed in the guide, e.g. "1.1". */
  number: string
  title: string
  className: string
  tags: { label: string; kind: string }[]
  /** Inner HTML of .algo-body, with print-only inline styles stripped. */
  body: string
}

export interface GuidePart {
  label: string
  title: string
  lede: string
  at: number
}

export declare function parseGuide(html: string): Record<string, GuideEntry>
export declare function parseParts(html: string): GuidePart[]
export declare function parseOutline(html: string): { className: string; part: string }[]
