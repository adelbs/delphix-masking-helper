import type { AlgoExample, AlgoText } from './algo-metadata'
import knowledge from './algo-knowledge.en.json'

/** English prose for each algorithm, shared with the server: the AI assistant builds its
 *  system prompt from the same JSON, so the chat and the UI describe algorithms identically.
 *  Param/label keys are dot-paths into the JSON Schema and must match the pt-BR entries. */
const TEXT: Record<string, AlgoText> = knowledge

/** Localized examples. Only the fields that differ from the pt-BR base are listed. */
const EXAMPLES: Record<string, Partial<AlgoExample>> = {
  CharacterMapping: {"input":"John Smith123","key":"secret-key"},
  NumericMapping: {"key":"numeric-key"},
  PaymentCard: {"key":"card-key"},
  CharacterReplacement: {"input":"Some example text","key":"key"},
  SegmentMapping: {"key":"id-key"},
  Shuffle: {"batchRows":["Mary Johnson","John Davis","Peter Miller","Anna Smith","Charles Wilson"]},
  StringAlgorithmChain: {"input":"John Smith","key":"chain-key"},
  RegexDecompose: {"input":"user@company.com"},
  FreeTextRedaction: {"input":"Contact John by email at john.smith@company.com."},
  Redact: {"input":"Contact John by email at john.smith@company.com."},
  MinMaxBigDecimal: {"key":"decimal-key"},
  MinMaxLocalDateTime: {"key":"date-key"},
  DateShift: {"key":"date-key"},
  DateShiftDiscrete: {"key":"date-key"},
  DateReplacement: {"key":"date-key"},
  SecureLookup: {"input":"John Smith","key":"lookup-key","sampleFiles":{"lookupFile":"firstnames.en.txt"}},
  NullSecureLookup: {"input":"sensitive-value","key":"lookup-key"},
  Mapping: {"config":{"mappingSet":{"algorithmName":"default-mapping-set"}},"input":"customer@email.com"},
  DataCleansing: {"input":"CA","sampleFiles":{"lookupFile":"mapping.en.csv"}},
  Email: {"input":"john.smith@company.com","key":"email-key"},
  Phone: {"input":"(555) 123-4567","key":"phone-key"},
  Name: {"input":"John","key":"name-key","sampleFiles":{"lookupFile":"firstnames.en.txt"}},
  FullName: {"input":"John Michael Smith","key":"name-key"},
  FinancialIdBr: {"key":"cpf-key"},
  IBAN: {"key":"iban-key"},
  Checkdigit: {"key":"check-key"},
  Tokenization: {"key":"strong-aes-key"},
  MultiColumnAddress: {"input":"123 Flower Street"},
  MultiColumnCondition: {"columns":[{"name":"key","type":"STRING","value":"F"},{"name":"string1","type":"STRING","value":"Mary"}]},
}

export const ALGO_TEXT_EN: Record<string, AlgoText> = Object.fromEntries(
  Object.entries(TEXT).map(([name, text]) => [
    name,
    EXAMPLES[name] ? { ...text, example: EXAMPLES[name] } : text,
  ])
)
