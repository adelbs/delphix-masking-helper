import type { Locale } from '@/types'
import { ALGO_TEXT_EN } from './algo-text.en'
import { ALGO_TEXT_ES } from './algo-text.es'

/** The ready-made example loaded by the "Example" button. */
export interface AlgoExample {
  config: Record<string, unknown>
  input: string
  key: string
  /** Maps a dot-path inside config (e.g. "lookupFile") to a server-side sample file name.
   *  When the example is loaded, AlgoTester calls /api/files/ensure-sample for each entry
   *  and injects the returned URI into config[path].uri automatically. */
  sampleFiles?: Record<string, string>
  /** Pre-populated columns for multi-column mode algorithms. */
  columns?: Array<{ name: string; type: string; value: string }>
  /** Pre-populated rows for batch mode algorithms (Shuffle). */
  batchRows?: string[]
}

/** The locale-dependent half of an algorithm's metadata. Anything set in `example`
 *  overrides the same field of the base example; everything else is inherited. */
export interface AlgoText {
  description?: string
  inputFormat?: string
  params?: Record<string, string>
  labels?: Record<string, string>
  example?: Partial<AlgoExample>
}

export interface AlgoMetadata {
  description?: string
  inputFormat?: string
  params?: Record<string, string>
  labels?: Record<string, string>
  example?: AlgoExample
  group?: AlgoGroup
  /** Algorithm requires batch input (multiple values at once). Shows table UI instead of single textarea. */
  batchMode?: boolean
  /** Algorithm supports reversible detokenization via REIDENTIFY mode. */
  reversible?: boolean
  /** Algorithm operates on a GenericDataRow (multiple columns) instead of a single value. */
  multiColumnMode?: boolean
}

/** Stable group ids. The visible label comes from the `group.*` message keys. */
export const GROUP_ORDER = [
  'personal',
  'dates',
  'numeric',
  'string',
  'freeText',
  'financial',
  'lookup',
  'multiColumn',
  'other',
] as const

export type AlgoGroup = (typeof GROUP_ORDER)[number]

const METADATA: Record<string, AlgoMetadata> = {
  CharacterMapping: {
    group: 'string',
    description: 'Mapeia cada caractere da entrada para um substituto dentro de grupos de caracteres configurados. Determinístico: o mesmo input+chave sempre gera o mesmo output. Ideal para mascarar textos alfanuméricos preservando o comprimento.',
    inputFormat: 'String de texto de qualquer comprimento. Caracteres fora dos grupos configurados são preservados sem alteração. Ex: "João Silva", "ABC123".',
    params: {
      characterGroups: 'Lista de strings, cada uma definindo um grupo de caracteres intercambiáveis (ex: "abcdefghijklmnopqrstuvwxyz"). Caracteres só são mapeados dentro do mesmo grupo.',
      caseSensitive: 'Se verdadeiro, trata maiúsculas e minúsculas como grupos separados.',
      minMaskedPositions: 'Número mínimo de posições que devem ser mascaradas.',
      preserveRanges: 'Array de {start, length, direction} para preservar partes da string sem mascarar.',
      preserveLeadingZeros: 'Se verdadeiro, preserva zeros à esquerda.',
    },
    labels: {
      characterGroups: 'Grupos de caracteres',
      caseSensitive: 'Sensível a maiúsculas/minúsculas',
      minMaskedPositions: 'Mínimo de posições mascaradas',
      preserveRanges: 'Intervalos a preservar',
      preserveLeadingZeros: 'Preservar zeros à esquerda',
    },
    example: { config: { characterGroups: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'], caseSensitive: true, minMaskedPositions: 1 }, input: 'João Silva123', key: 'chave-secreta' },
  },
  NumericMapping: {
    group: 'numeric',
    description: 'Mapeia um valor numérico para outro de forma determinística, dentro do intervalo [minValue, maxValue].',
    inputFormat: 'Número inteiro positivo, sem casas decimais, sem pontuação. Ex: "12345".',
    params: { minValue: 'Valor mínimo do intervalo de saída.', maxValue: 'Valor máximo do intervalo de saída.' },
    labels: { minValue: 'Valor mínimo', maxValue: 'Valor máximo' },
    example: { config: { minValue: 10000, maxValue: 99999 }, input: '12345', key: 'chave-num' },
  },
  PaymentCard: {
    group: 'financial',
    description: 'Mascara número de cartão de pagamento. Preserva o BIN e/ou os últimos dígitos, mantendo o dígito verificador Luhn válido.',
    inputFormat: 'Número de cartão, com ou sem espaços/traços. Ex: "4111 1111 1111 1111"',
    params: { minMaskedPositions: 'Número mínimo de posições mascaradas.', preserve: 'Número de dígitos do final do cartão a preservar.' },
    labels: { minMaskedPositions: 'Mínimo de posições mascaradas', preserve: 'Dígitos finais a preservar' },
    example: { config: { preserve: 4, minMaskedPositions: 6 }, input: '4111111111111111', key: 'chave-cartao' },
  },
  CharacterReplacement: {
    group: 'string',
    description: 'Aplica regras de substituição caractere a caractere: cada regra define quais caracteres do input são trocados e por qual caractere. Útil para normalizar ou redimir caracteres específicos (ex: substituir vogais por "*").',
    inputFormat: 'String de texto de qualquer comprimento. Ex: "Texto 123".',
    params: {
      stringAlgorithm: 'Algoritmo de mascaramento aplicado ao input antes das regras de substituição. Informe o nome de uma instância do catálogo. O resultado desse algoritmo é então processado pelas replacementRules.',
      replacementRules: 'Lista de regras de substituição aplicadas em sequência. Cada regra define um conjunto de caracteres a identificar e o caractere que os substituirá.',
      'replacementRules.filteredCharacters': 'Lista de caracteres que esta regra detecta no input (versão simplificada: se não usar input/output separados). Cada ocorrência de qualquer caractere desta lista é substituída pelo replacementCharacter.',
      'replacementRules.replacementCharacter': 'Caractere único que substitui cada caractere encontrado em filteredCharacters. Ex: "*" transforma "João" em "J**o" (se filteredCharacters = ["ã","o"]).',
      'replacementRules.inputFilteredCharacters': 'Lista de caracteres que esta regra detecta no input (versão avançada com input/output separados). Alternativa a filteredCharacters — permite ter conjuntos diferentes para leitura e escrita.',
      'replacementRules.inputReplacementCharacter': 'Caractere usado quando a correspondência vem de inputFilteredCharacters. Substituído no output final pelo outputReplacementCharacter.',
      'replacementRules.outputFilteredCharacters': 'Lista de caracteres que, se aparecerem no output de outro algoritmo (stringAlgorithm), serão substituídos. Usado junto com outputReplacementCharacter.',
      'replacementRules.outputReplacementCharacter': 'Caractere que substitui os caracteres encontrados em outputFilteredCharacters.',
      requireInputChange: 'Se verdadeiro, exige que ao menos uma substituição tenha sido feita. Se nenhuma regra produziu mudança no input, o algoritmo lança erro. Útil para garantir que o mascaramento realmente alterou o valor.',
      filterAccents: 'Remove acentos antes de aplicar as regras, após, em ambas as etapas, ou nunca. INPUT = remove acentos do input antes de processar as regras. OUTPUT = remove acentos do resultado final. BOTH = remove em ambos. NONE = não remove acentos (padrão).',
    },
    labels: {
      stringAlgorithm: 'Algoritmo pré-processador (aplicado antes das regras)',
      replacementRules: 'Regras de substituição',
      'replacementRules.filteredCharacters': 'Caracteres a substituir',
      'replacementRules.replacementCharacter': 'Caractere substituto',
      'replacementRules.inputFilteredCharacters': 'Caracteres do input a detectar (avançado)',
      'replacementRules.inputReplacementCharacter': 'Substituto para inputFilteredCharacters',
      'replacementRules.outputFilteredCharacters': 'Caracteres do output a substituir (avançado)',
      'replacementRules.outputReplacementCharacter': 'Substituto para outputFilteredCharacters',
      requireInputChange: 'Exigir que ao menos uma substituição ocorra',
      filterAccents: 'Remoção de acentos',
    },
    example: { config: { replacementRules: [{ filteredCharacters: ['a','e','i','o','u','A','E','I','O','U'], replacementCharacter: '*' }] }, input: 'Exemplo de texto', key: 'chave' },
  },
  SegmentMapping: {
    group: 'string',
    description: 'Divide a string em segmentos de tamanho fixo e aplica mascaramento independente em cada um. Ideal para documentos com formato definido: CPF, CNPJ, CEP, código de barras.',
    inputFormat: 'String com formato fixo. Os separadores (pontos, traços, barras) são ignorados automaticamente se autoIgnoreCharacters=true. Ex: "123.456.789-09" (CPF), "12.345.678/0001-90" (CNPJ).',
    params: {
      segments: 'Obrigatório. Lista de segmentos na ordem em que aparecem no valor (ignorando os caracteres de ignoreCharacters). Cada segmento define seu comprimento e como deve ser tratado.',
      'segments.length': 'Obrigatório. Quantidade de caracteres deste segmento (não conta os caracteres ignorados). Ex: no CPF "123.456.789-09", o primeiro segmento tem length=3.',
      'segments.segmentType': 'Obrigatório. MASK_NUMERIC = mascara os dígitos substituindo por outros dígitos aleatórios (0-9). MASK_ALPHANUMERIC = mascara substituindo por caracteres alfanuméricos. PRESERVE = mantém os caracteres originais sem alterar. CONSTANT = substitui o segmento inteiro por um valor fixo definido em maskValues.',
      'segments.inputValues': 'Conjunto de caracteres válidos para este segmento no input, como string contínua. Ex: "0123456789" para aceitar apenas dígitos. Se o input tiver caractere fora deste conjunto, o comportamento depende da configuração. Deixe vazio para aceitar qualquer caractere.',
      'segments.maskValues': 'Conjunto de caracteres usados como pool de substituição para este segmento, como string contínua. Ex: "123456789" (exclui o zero) força que o segmento mascarado nunca comece com 0. Deixe vazio para usar o conjunto padrão do tipo (0-9 para MASK_NUMERIC).',
      ignoreCharacters: 'Lista de códigos ASCII dos caracteres a ignorar ao dividir a string em segmentos. Ex: 46 = ponto, 45 = traço, 47 = barra. Esses caracteres são pulados na contagem de posições dos segmentos e recolocados no output na mesma posição original.',
      autoIgnoreCharacters: 'Se verdadeiro, detecta automaticamente quais caracteres não são alfanuméricos e os ignora ao dividir em segmentos — equivalente a configurar ignoreCharacters manualmente para todos os separadores encontrados. Ative para CPF, CNPJ, CEP sem precisar listar os códigos ASCII.',
      allowShortSegments: 'Se verdadeiro, aceita input mais curto que o total de caracteres definidos nos segmentos. Os segmentos finais incompletos são processados com o que houver. false (padrão) = lança erro se o input for menor que o esperado.',
      processPreserveBeforeIgnore: 'Controla a ordem de operação entre caracteres ignorados e segmentos PRESERVE. true = os segmentos PRESERVE são calculados antes de remover os caracteres ignorados (útil quando o separador cai dentro de um segmento PRESERVE). false (padrão) = os caracteres ignorados são removidos antes de calcular as posições dos segmentos.',
    },
    labels: {
      segments: 'Segmentos',
      'segments.length': 'Comprimento (caracteres)',
      'segments.segmentType': 'Tipo do segmento',
      'segments.inputValues': 'Caracteres válidos no input (pool de entrada)',
      'segments.maskValues': 'Caracteres usados na substituição (pool de saída)',
      ignoreCharacters: 'Caracteres a ignorar (códigos ASCII)',
      autoIgnoreCharacters: 'Detectar separadores automaticamente',
      allowShortSegments: 'Aceitar input mais curto que o esperado',
      processPreserveBeforeIgnore: 'Calcular PRESERVE antes de remover ignorados',
    },
    example: { config: { autoIgnoreCharacters: true, segments: [{ length: 3, segmentType: 'MASK_NUMERIC' }, { length: 1, segmentType: 'PRESERVE' }, { length: 3, segmentType: 'MASK_NUMERIC' }, { length: 1, segmentType: 'PRESERVE' }, { length: 3, segmentType: 'MASK_NUMERIC' }, { length: 1, segmentType: 'PRESERVE' }, { length: 2, segmentType: 'MASK_NUMERIC' }] }, input: '123.456.789-09', key: 'chave-cpf' },
  },
  Shuffle: {
    group: 'string',
    description: 'Redistribui valores entre registros aleatoriamente — cada linha recebe o valor de outra linha, preservando o conjunto original. A ordem muda a cada execução (não é determinístico): isso é intencional, pois uma permutação reproduzível permitiria re-executar o shuffle e de-anonimizar os dados. Opera em modo batch: precisa de múltiplos valores de uma vez.',
    inputFormat: 'Múltiplos valores de texto (um por linha da tabela). Cada valor deve ter comprimento ≥ minimumShuffleSize. Os valores são trocados entre as linhas — nenhum valor é inventado, apenas a posição muda. A cada clique em "Embaralhar lote" a ordem será diferente.',
    params: { minimumShuffleSize: 'Comprimento mínimo de cada valor para ser embaralhado (padrão: 3).' },
    labels: { minimumShuffleSize: 'Tamanho mínimo' },
    batchMode: true,
    example: { config: { minimumShuffleSize: 3 }, input: '', key: 'delphix-default-key', batchRows: ['Maria Silva', 'João Costa', 'Pedro Lima', 'Ana Santos', 'Carlos Pereira'] },
  },
  StringAlgorithmChain: {
    group: 'string',
    description: 'Encadeia múltiplos algoritmos em sequência: a saída de cada um é a entrada do próximo. Mínimo de 2 algoritmos. Os nomes devem ser instâncias do catálogo embutido (ex: "dlpx-core:FirstName") ou do Masking Engine.',
    inputFormat: 'String de texto compatível com o primeiro algoritmo da cadeia. O exemplo usa nomes encadeados: FirstName → LastName.',
    params: { algorithmReferences: 'Array de referências a algoritmos por nome de instância. Mínimo: 2 entradas. Ex: [{ name: "dlpx-core:FirstName" }, { name: "dlpx-core:LastName" }].' },
    labels: { algorithmReferences: 'Algoritmos em sequência' },
    example: { config: { algorithmReferences: [{ name: 'dlpx-core:FirstName' }, { name: 'dlpx-core:LastName' }] }, input: 'Joao Silva', key: 'chave-chain' },
  },
  RegexDecompose: {
    group: 'string',
    description: 'Decompõe a string em partes usando regex e aplica uma ação diferente em cada parte. O regex deve casar com a string inteira; cada grupo de captura (parênteses) recebe sua própria ação. O texto entre grupos é preservado automaticamente.',
    inputFormat: 'Qualquer string. O algoritmo testa cada padrão na ordem até um casar. Se nenhum casar, aplica a "Ação de fallback". Ex: "usuario@empresa.com" com regex "([^@]+)(@.+)" → grupo 1 = "usuario", grupo 2 = "@empresa.com".',
    params: {
      maskPatterns: 'Lista de padrões testados em ordem. O primeiro cujo regex casar com a string inteira é usado. Cada padrão tem um regex e uma lista de ações — precisa haver exatamente uma ação por grupo de captura (parênteses).',
      'maskPatterns.regex': 'Expressão regular que deve casar com a string INTEIRA (anchored implicitamente). Use grupos de captura (parênteses) para delimitar as partes que receberão ações. O texto entre grupos é preservado automaticamente.',
      'maskPatterns.actions': 'Uma ação por grupo de captura, na mesma ordem dos parênteses no regex. Se o regex tem 2 grupos, coloque 2 ações.',
      'maskPatterns.actions.type': 'PRESERVE — mantém o texto original do grupo sem alteração. TRUNCATE — remove o grupo completamente (substitui por string vazia). REDACT — substitui o grupo por um texto ou caractere fixo (configure abaixo). APPLY_ALGORITHM — passa o grupo por um algoritmo de mascaramento (escolha o algoritmo abaixo).',
      'maskPatterns.actions.redactString': 'Texto fixo que substituirá o grupo inteiro. Ex: "***" transforma "joao" em "***". Use quando quiser uma substituição uniforme independente do tamanho. Usado somente quando o tipo é REDACT.',
      'maskPatterns.actions.redactCharacter': 'Caractere único usado para substituir cada caractere do grupo individualmente. Ex: "X" transforma "joao" em "XXXX" (preserva o tamanho). Usado somente quando o tipo é REDACT. Mutuamente exclusivo com "Texto substituto" — use um ou outro.',
      'maskPatterns.actions.algorithm': 'Algoritmo de mascaramento aplicado ao grupo. Selecione um teste/algoritmo salvo no combo, ou digite diretamente um nome do catálogo built-in (ex: dlpx-core:FirstName). Usado somente quando o tipo é APPLY_ALGORITHM.',
      fallbackAction: 'Ação aplicada quando a string não casa com nenhum dos padrões. Se "Exigir casamento" estiver ativo, esta ação é ignorada e o algoritmo lança erro.',
      'fallbackAction.type': 'PRESERVE — retorna o valor original inalterado. TRUNCATE — retorna string vazia. REDACT — substitui o valor inteiro. APPLY_ALGORITHM — passa o valor por um algoritmo.',
      'fallbackAction.redactString': 'Texto fixo que substituirá o valor inteiro no fallback.',
      'fallbackAction.redactCharacter': 'Caractere usado para substituir cada caractere do valor no fallback.',
      'fallbackAction.algorithm': 'Algoritmo aplicado ao valor inteiro no fallback.',
      trimInput: 'Remove espaços e quebras de linha das extremidades do valor antes de tentar casar com os padrões. Útil quando os dados vêm com padding do banco.',
      requireMask: 'Se ativo, lança erro quando a string não casa com nenhum padrão (em vez de usar o fallback). Use quando valores fora do formato esperado devem ser rejeitados.',
      maxInputLength: 'Comprimento máximo permitido do valor de entrada em caracteres. Valores mais longos resultam em erro. Deixe vazio para não impor limite.',
    },
    labels: {
      maskPatterns: 'Padrões de mascaramento',
      'maskPatterns.regex': 'Regex (deve casar com a string inteira)',
      'maskPatterns.actions': 'Ações por grupo de captura',
      'maskPatterns.actions.type': 'Tipo de ação',
      'maskPatterns.actions.redactString': 'Texto substituto fixo',
      'maskPatterns.actions.redactCharacter': 'Caractere de substituição (preserva tamanho)',
      'maskPatterns.actions.algorithm': 'Algoritmo a aplicar',
      fallbackAction: 'Ação de fallback (quando nenhum padrão casa)',
      'fallbackAction.type': 'Tipo de ação',
      'fallbackAction.redactString': 'Texto substituto fixo',
      'fallbackAction.redactCharacter': 'Caractere de substituição',
      'fallbackAction.algorithm': 'Algoritmo a aplicar',
      trimInput: 'Remover espaços das extremidades antes de processar',
      requireMask: 'Exigir casamento (erro se nenhum padrão casar)',
      maxInputLength: 'Tamanho máximo do valor de entrada (caracteres)',
    },
    example: {
      config: {
        maskPatterns: [{
          regex: '([^@]+)(@[^@]+)',
          actions: [{ type: 'REDACT', redactString: '***' }, { type: 'PRESERVE' }],
        }],
        fallbackAction: { type: 'PRESERVE' },
        trimInput: true,
        requireMask: false,
      },
      input: 'usuario@empresa.com.br',
      key: '',
    },
  },
  FreeTextRedaction: {
    group: 'freeText',
    description: 'Encontra e redige entidades sensíveis em texto livre usando regex e/ou arquivo de lookup. O restante é preservado.',
    inputFormat: 'Texto livre. Ex: "Contate João pelo e-mail joao@empresa.com ou CPF 123.456.789-09."',
    params: {
      regularExpressions: 'Array de {patternString} com regex para identificar trechos a redimir.',
      isDenyList: 'true = lista de bloqueio: redige os matches. false = lista de permissão: redige tudo que NÃO casa.',
      regExRedactValue: 'Texto que substitui os trechos encontrados pelas expressões regulares.',
      lookupFile: 'Arquivo de texto com uma lista de termos (um por linha) a buscar no input. Cada ocorrência encontrada é redigida.',
      lookupFileRedactValue: 'Texto que substitui os trechos encontrados pelo arquivo de lookup (independente do regExRedactValue).',
    },
    labels: {
      regularExpressions: 'Expressões regulares',
      isDenyList: 'Modo lista de bloqueio',
      regExRedactValue: 'Substituição para matches de regex',
      lookupFile: 'Arquivo de termos (lookup)',
      lookupFileRedactValue: 'Substituição para matches do arquivo',
    },
    example: { config: { isDenyList: true, regExRedactValue: '[REDACTED]', regularExpressions: [{ patternString: '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}' }] }, input: 'Contate João pelo e-mail joao.silva@empresa.com.', key: '' },
  },
  Redact: {
    group: 'freeText',
    description: 'Substitui trechos do valor que correspondem a expressões regulares pelo texto de substituição configurado. Se nenhuma regex for configurada, retorna o valor de entrada sem mascaramento.',
    inputFormat: 'Qualquer string de texto. Trechos que casarem com as regex configuradas serão redigidos.',
    params: { regexRedact: 'Mapa de {regex → texto_substituição}. Se vazio, todo o valor é redigido.' },
    labels: { regexRedact: 'Mapeamento regex → substituição' },
    example: { config: { regexRedact: { '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}': '[EMAIL]' } }, input: 'Contate João pelo e-mail joao.silva@empresa.com.', key: '' },
  },
  MinMaxBigDecimal: {
    group: 'numeric',
    description: 'Limita um número decimal ao intervalo [minValue, maxValue]: retorna o valor sem alteração se já estiver dentro do intervalo, minValue se for menor, ou maxValue se for maior.',
    inputFormat: 'Número decimal. Ex: "5000.50", "3.14"',
    params: { minValue: 'Obrigatório. Limite inferior.', maxValue: 'Obrigatório. Limite superior.', nonConformingDataDefaultValue: 'Valor retornado quando a entrada não é um número válido. Se vazio, o algoritmo lança um erro de dado não-conforme.' },
    labels: { minValue: 'Valor mínimo', maxValue: 'Valor máximo', nonConformingDataDefaultValue: 'Valor padrão para dado inválido' },
    example: { config: { minValue: 1000, maxValue: 9999 }, input: '5000.50', key: 'chave-decimal' },
  },
  MinMaxLocalDateTime: {
    group: 'dates',
    description: 'Limita uma data/hora ao intervalo [minDate, maxDate]: retorna o valor sem alteração se já estiver dentro do intervalo, minDate se for anterior, ou maxDate se for posterior.',
    inputFormat: 'Data/hora em formato ISO. Ex: "2024-03-15T14:30:00"',
    params: { minDate: 'Obrigatório. Data/hora mínima (formato ISO).', maxDate: 'Obrigatório. Data/hora máxima (formato ISO).', nonConformingDataDefaultValue: 'Valor retornado quando a entrada não é uma data/hora válida. Se vazio, o algoritmo lança um erro de dado não-conforme.' },
    labels: { minDate: 'Data/hora mínima', maxDate: 'Data/hora máxima', nonConformingDataDefaultValue: 'Valor padrão para dado inválido' },
    example: { config: { minDate: '1970-01-01T00:00:00', maxDate: '2000-12-31T23:59:59' }, input: '1985-06-15T08:00:00', key: 'chave-data' },
  },
  NumericExpression: {
    group: 'numeric',
    description: 'Avalia uma expressão Java de uma linha sobre o valor numérico de entrada e retorna o resultado como BigDecimal. A expressão tem acesso à variável "input" (o valor de entrada como BigDecimal) e à variável "seed" (long derivado da chave, útil para mascaramento determinístico). Constantes nomeadas adicionais podem ser definidas no campo "constants".',
    inputFormat: 'Número (inteiro ou decimal). Ex: "1000", "3.14"',
    params: {
      expression: 'Obrigatório. Expressão Java válida que retorna BigDecimal. Variáveis disponíveis: "input" (BigDecimal com o valor de entrada) e "seed" (long determinístico baseado na chave). Ex: input.multiply(new java.math.BigDecimal(2)) — dobra o valor. Ex: new java.math.BigDecimal(seed % 9000 + 1000) — gera valor entre 1000 e 9999 baseado na chave.',
      inputType: 'Como interpretar a entrada antes de passá-la para a expressão: DOUBLE, LONG ou BIG_DECIMAL (padrão).',
      constants: 'Constantes nomeadas acessíveis na expressão. Cada constante tem um "name" e um "value" (string). Ex: name="taxa", value="0.8" — acessada na expressão como new java.math.BigDecimal(taxa).',
      nonConformingDataDefaultValue: 'Valor retornado quando a entrada não é um número válido. Se vazio, o algoritmo lança um erro de dado não-conforme.',
    },
    labels: { expression: 'Expressão Java', inputType: 'Tipo numérico de entrada', constants: 'Constantes', nonConformingDataDefaultValue: 'Valor padrão para dado inválido' },
    example: { config: { expression: 'input.setScale(0, java.math.RoundingMode.HALF_UP)', inputType: 'BIG_DECIMAL' }, input: '1234.56', key: '' },
  },
  RepeatFirstDigit: {
    group: 'numeric',
    description: 'Mascara os 4 dígitos finais repetindo o primeiro dígito deles 4 vezes.',
    inputFormat: 'String numérica com exatamente 4, 9, 10 ou 14 dígitos (sem pontuação). Ex: "1234", "123456789".',
    example: { config: {}, input: '1234', key: '' },
  },
  DateShift: {
    group: 'dates',
    description: 'Desloca uma data/hora por um valor aleatório dentro do intervalo [minRange, maxRange]. O deslocamento é determinístico pela chave: o mesmo input+chave sempre produz o mesmo resultado.',
    inputFormat: 'Data ou data/hora em formato ISO 8601: "yyyy-MM-dd" ou "yyyy-MM-ddTHH:mm:ss". Ex: "2024-03-15", "2024-03-15T14:30:00".',
    params: {
      minRange: 'Deslocamento mínimo em unidades de "unit". Use valor negativo para permitir deslocamento para o passado. Ex: -365 com unit=DAYS permite recuar até 1 ano.',
      maxRange: 'Deslocamento máximo em unidades de "unit". Use valor positivo para permitir deslocamento para o futuro. Ex: 365 com unit=DAYS permite avançar até 1 ano.',
      unit: 'Unidade do deslocamento: SECONDS, MINUTES, HOURS, DAYS, MONTHS, YEARS.',
      roll: 'Controla o que acontece quando o deslocamento resulta em uma data inválida — relevante principalmente com unit=MONTHS ou YEARS. Ex: 31 de janeiro + 1 mês = 31 de fevereiro não existe. true (roll) = a data "encolhe" para o último dia válido do mês destino (→ 28/fev). false (add) = a data transborda para o próximo mês (→ 3/mar). Se não tiver certeza, use false.',
    },
    labels: {
      minRange: 'Deslocamento mínimo',
      maxRange: 'Deslocamento máximo',
      unit: 'Unidade de tempo',
      roll: 'Roll (encurtar ao último dia válido) em vez de transbordar',
    },
    example: { config: { minRange: -365, maxRange: 365, unit: 'DAYS' }, input: '2024-03-15', key: 'chave-data' },
  },
  DateShiftDiscrete: {
    group: 'dates',
    description: 'Versão do Date Shift com conjunto discreto de deslocamentos possíveis, definidos via arquivo de configuração.',
    inputFormat: 'Data ou data/hora em formato ISO 8601: "yyyy-MM-dd" ou "yyyy-MM-ddTHH:mm:ss". Ex: "2024-03-15", "2024-03-15T14:30:00".',
    example: { config: {}, input: '2024-03-15', key: 'chave-data' },
  },
  DateReplacement: {
    group: 'dates',
    description: 'Substitui a data/hora por um valor aleatório absoluto dentro do intervalo [minDate, maxDate]. As datas de configuração devem usar o formato "yyyy-MM-ddTHH:mm:ss".',
    inputFormat: 'Data/hora em formato ISO 8601: "yyyy-MM-ddTHH:mm:ss". Ex: "1985-07-20T00:00:00".',
    params: { minDate: 'Data mínima possível (formato: "yyyy-MM-ddTHH:mm:ss").', maxDate: 'Data máxima possível (formato: "yyyy-MM-ddTHH:mm:ss").', unit: 'SECONDS, MINUTES, HOURS, DAYS.' },
    labels: { minDate: 'Data mínima', maxDate: 'Data máxima', unit: 'Unidade de tempo' },
    example: { config: { minDate: '1970-01-01T00:00:00', maxDate: '2000-12-31T00:00:00', unit: 'DAYS' }, input: '1985-07-20T00:00:00', key: 'chave-data' },
  },
  SecureLookup: {
    group: 'lookup',
    description: 'Substitui o valor por um item de um arquivo de lookup, escolhido de forma determinística por hash. O mesmo input+chave sempre seleciona o mesmo substituto do arquivo.',
    inputFormat: 'Qualquer string não nula. O algoritmo calcula um hash do valor+chave e usa-o para selecionar uma linha do arquivo de lookup.',
    params: {
      lookupFile: 'Obrigatório. Arquivo de texto com um valor substituto por linha. O algoritmo usa o hash do input para selecionar qual linha retornar. Quanto mais linhas, maior a diversidade de substitutos.',
      hashMethod: 'Algoritmo usado para derivar o índice no arquivo de lookup. SHA256 = hash criptográfico seguro, determinístico por chave (padrão recomendado). LEGACY = método antigo de hash, mantido para retrocompatibilidade. RANDOMIZE = seleção aleatória não determinística (cada execução pode retornar um valor diferente).',
      maskedValueCase: 'Capitalização aplicada ao valor retornado do arquivo. PRESERVE_LOOKUP_FILE = retorna exatamente como está no arquivo. PRESERVE_INPUT = aplica ao substituto a mesma capitalização do input (ex: input todo maiúsculo → substituto todo maiúsculo). ALL_LOWER = força minúsculas. ALL_UPPER = força maiúsculas.',
      inputCaseSensitive: 'Se verdadeiro, "João" e "JOÃO" são tratados como valores diferentes e podem ter substitutos diferentes. Se falso, a comparação ignora maiúsculas/minúsculas antes de calcular o hash.',
      trimWhitespaceFromInput: 'Se verdadeiro, remove espaços e tabs das extremidades do input antes de calcular o hash. Útil quando os dados vêm com padding do banco e você quer que "  João  " produza o mesmo resultado que "João".',
      trimWhitespaceInLookupFile: 'Se verdadeiro, remove espaços e tabs das extremidades de cada linha do arquivo de lookup ao carregá-lo. Evita que linhas com espaço sobrando no final sejam tratadas como valores distintos.',
    },
    labels: {
      lookupFile: 'Arquivo de lookup (um valor por linha)',
      hashMethod: 'Método de seleção do substituto',
      maskedValueCase: 'Capitalização do resultado',
      inputCaseSensitive: 'Diferenciar maiúsculas/minúsculas no input',
      trimWhitespaceFromInput: 'Remover espaços do input antes do hash',
      trimWhitespaceInLookupFile: 'Remover espaços das linhas do arquivo de lookup',
    },
    example: { config: { lookupFile: { uri: '' }, hashMethod: 'SHA256', maskedValueCase: 'PRESERVE_LOOKUP_FILE' }, input: 'João da Silva', key: 'chave-lookup', sampleFiles: { 'lookupFile': 'firstnames.txt' } },
  },
  NullSecureLookup: {
    group: 'lookup',
    description: 'Versão do Secure Lookup com tratamento de valores nulos. Não possui parâmetros configuráveis — usa o arquivo de lookup embutido no plugin. No runner standalone, retorna null para qualquer entrada (comportamento esperado sem o contexto do Masking Engine).',
    inputFormat: 'Qualquer string. No runner standalone, a saída será sempre null (sem engine context). No Masking Engine, se o input for null, retorna null; caso contrário, aplica o lookup configurado.',
    example: { config: {}, input: 'valor-sensivel', key: 'chave-lookup' },
  },
  Mapping: {
    group: 'lookup',
    description: 'Mantém um mapeamento persistente 1-para-1 de originais para substitutos, garantindo consistência referencial: o mesmo valor original sempre recebe o mesmo substituto em todas as tabelas. Requer banco de dados de mapeamento — não funciona no runner standalone.',
    inputFormat: 'Qualquer string. O algoritmo consulta (ou cria) um registro no mapping set e retorna sempre o mesmo substituto para cada valor original.',
    params: {
      mappingSet: 'Obrigatório. Referência ao conjunto de mapeamento que armazena as correspondências. No runner standalone, esse banco não está disponível e o algoritmo falhará.',
      'mappingSet.algorithmName': 'Obrigatório. Nome do mapping set no Masking Engine — identifica qual conjunto de mapeamentos usar. Ex: "client-name-mapping".',
      'mappingSet.host': 'Host do banco de dados onde o mapping set está armazenado. Usado quando o mapping set está em uma instância remota do Masking Engine.',
      'mappingSet.port': 'Porta do banco de dados do mapping set remoto.',
      'mappingSet.database': 'Nome do banco de dados do mapping set remoto.',
      'mappingSet.schema': 'Schema do banco de dados do mapping set remoto.',
      'mappingSet.isRemote': 'Se verdadeiro, o mapping set está em uma instância remota do Masking Engine (usando host/port/database/schema acima). Se falso, usa a instância local.',
      'mappingSet.mappingLookupKey': 'Chave adicional usada para particionar o mapping set. Permite que o mesmo mapping set sirva a múltiplos contextos isolados.',
      'mappingSet.propertiesRef': 'Arquivo de propriedades com configurações de conexão ao banco do mapping set remoto (alternativa a definir host/port/database/schema individualmente).',
      ignoreCharacters: 'Lista de códigos ASCII de caracteres a remover do input antes de fazer o lookup no mapping set. Ex: 45 = traço, 46 = ponto. Útil para normalizar CPFs com e sem formatação ao mesmo mapeamento.',
    },
    labels: {
      mappingSet: 'Conjunto de mapeamento',
      'mappingSet.algorithmName': 'Nome do mapping set',
      'mappingSet.host': 'Host do banco remoto',
      'mappingSet.port': 'Porta do banco remoto',
      'mappingSet.database': 'Banco de dados remoto',
      'mappingSet.schema': 'Schema do banco remoto',
      'mappingSet.isRemote': 'Mapping set remoto',
      'mappingSet.mappingLookupKey': 'Chave de partição do mapping set',
      'mappingSet.propertiesRef': 'Arquivo de propriedades de conexão',
      ignoreCharacters: 'Caracteres a ignorar no input (códigos ASCII)',
    },
    example: { config: { mappingSet: { algorithmName: 'mapping-set-padrao' } }, input: 'cliente@email.com', key: '' },
  },
  DataCleansing: {
    group: 'lookup',
    description: 'Substitui o valor pela correspondência definida em um arquivo de mapeamento (original → substituto). Diferente do Secure Lookup, o mapeamento é explícito e determinístico: você controla exatamente qual valor vira qual.',
    inputFormat: 'String que deve ter correspondência no arquivo de mapeamento. Se não houver correspondência, o comportamento padrão é retornar o valor original sem alteração. Ex: "SP" → "São Paulo", "M" → "Masculino".',
    params: {
      lookupFile: 'Obrigatório. Arquivo de texto com um mapeamento por linha. Cada linha tem o valor original e o substituto separados pelo delimiter. Ex com delimiter=",": "SP,São Paulo" ou "masculino,M".',
      delimiter: 'Separador entre o valor original e o substituto em cada linha do arquivo. Ex: "," para CSV, ";" para ponto-e-vírgula, "\t" para tab. Se omitido, usa tab por padrão.',
      caseSensitive: 'Se verdadeiro, "SP" e "sp" são tratados como valores diferentes e precisam de entradas separadas no arquivo. Se falso (recomendado para a maioria dos casos), a comparação ignora maiúsculas/minúsculas.',
      trimWhitespace: 'Se verdadeiro, remove espaços e tabs das extremidades do input e de cada linha do arquivo antes de comparar. Evita falhas de correspondência por espaços sobrando no banco ou no arquivo.',
    },
    labels: {
      lookupFile: 'Arquivo de mapeamento (original → substituto)',
      delimiter: 'Delimitador entre original e substituto',
      caseSensitive: 'Diferenciar maiúsculas/minúsculas',
      trimWhitespace: 'Remover espaços das extremidades antes de comparar',
    },
    example: { config: { lookupFile: { uri: '' }, delimiter: ',', caseSensitive: false }, input: 'SP', key: '', sampleFiles: { 'lookupFile': 'mapping.csv' } },
  },
  Email: {
    group: 'personal',
    description: 'Mascara endereço de e-mail gerando um endereço sintético.',
    inputFormat: 'Endereço de e-mail válido. Ex: "joao.silva@empresa.com.br"',
    params: {
      nameAction: 'Obrigatório. Como mascarar a parte do nome: UNIQUE, LOOKUP, APPLY_ALGORITHM, APPLY_FIRSTNAME_AND_LASTNAME_ALGORITHMS.',
      domainAction: 'Obrigatório. Como mascarar o domínio: REPLACEMENT (substituir por domainReplacementString), APPLY_ALGORITHM, PRESERVE.',
      domainReplacementString: 'Domínio substituto quando domainAction=REPLACEMENT. Ex: "example.com".',
      errorHandlingAction: 'Ação em caso de erro: EXCEPTION, CHARACTER_MAPPING, PRESERVE.',
    },
    labels: {
      nameAction: 'Ação para o nome',
      domainAction: 'Ação para o domínio',
      domainReplacementString: 'Domínio substituto',
      errorHandlingAction: 'Ação em caso de erro',
    },
    example: { config: { nameAction: 'UNIQUE', domainAction: 'REPLACEMENT', domainReplacementString: 'example.com', errorHandlingAction: 'PRESERVE' }, input: 'joao.silva@empresa.com.br', key: 'chave-email' },
  },
  Phone: {
    group: 'personal',
    description: 'Gera um número de telefone sintético preservando o formato original.',
    inputFormat: 'Número de telefone em qualquer formato. Ex: "(11) 99999-8888"',
    params: { isPhoneUnique: 'Obrigatório. Se verdadeiro, garante substitutos únicos.' },
    labels: { isPhoneUnique: 'Garantir unicidade do número' },
    example: { config: { isPhoneUnique: true }, input: '(11) 99999-8888', key: 'chave-fone' },
  },
  Name: {
    group: 'personal',
    description: 'Substitui um nome simples (primeiro nome ou sobrenome) por outro sorteado de forma determinística a partir de um arquivo de lookup. O mesmo input+chave sempre produz o mesmo substituto.',
    inputFormat: 'Nome simples, sem separadores. Ex: "João", "Silva", "Maria". Para nomes compostos use FullName.',
    params: {
      lookupFile: 'Obrigatório. Arquivo de texto com um nome por linha. O algoritmo sorteia um nome desse arquivo de forma determinística (baseada na chave). Pode usar qualquer lista — nomes masculinos, femininos, sobrenomes, etc.',
      maskedValueCase: 'Capitalização aplicada ao nome sorteado do arquivo. PRESERVE_LOOKUP_FILE = usa o nome exatamente como está no arquivo. PRESERVE_INPUT = aplica ao substituto a mesma capitalização do input (ex: input "JOÃO" → substituto em maiúsculas). ALL_LOWER = tudo minúsculo. ALL_UPPER = tudo maiúsculo.',
      particlesToRemoveFile: 'Arquivo com partículas que devem ser removidas do input antes do lookup (uma por linha). Ex: "de", "da", "dos" — evita que partículas influenciem o hash e produzam nomes substitutos sem sentido.',
      particlesToPreserveFile: 'Arquivo com partículas que devem ser mantidas no resultado mesmo após o mascaramento (uma por linha). Ex: "de", "da" — o substituto gerado preserva as partículas do input original.',
      maxLengthOfMaskedName: 'Comprimento máximo do nome substituto em caracteres. Nomes do arquivo de lookup que excederem esse limite são ignorados na seleção. Útil quando a coluna no banco tem restrição de tamanho.',
      maxNumberNames: 'Número máximo de nomes retornados quando o algoritmo opera em modo multi-valor. Para uso simples (campo único), deixe vazio.',
      filterAccent: 'Se verdadeiro, remove acentos do input antes de calcular o hash para seleção do substituto. Útil para tratar "Jose" e "José" como equivalentes, garantindo que produzam o mesmo nome mascarado.',
      inputCaseSensitive: 'Se verdadeiro, "João" e "JOÃO" são tratados como inputs diferentes e podem produzir substitutos diferentes. Se falso (padrão), a comparação ignora maiúsculas/minúsculas.',
    },
    labels: {
      lookupFile: 'Arquivo de nomes substitutos',
      maskedValueCase: 'Capitalização do resultado',
      particlesToRemoveFile: 'Arquivo de partículas a remover (ex: "de", "da")',
      particlesToPreserveFile: 'Arquivo de partículas a preservar no resultado',
      maxLengthOfMaskedName: 'Comprimento máximo do nome substituto',
      maxNumberNames: 'Número máximo de nomes (modo multi-valor)',
      filterAccent: 'Ignorar acentos ao calcular o substituto',
      inputCaseSensitive: 'Diferenciar maiúsculas/minúsculas no input',
    },
    example: { config: { lookupFile: { uri: '' }, maskedValueCase: 'PRESERVE_INPUT' }, input: 'João', key: 'chave-nome', sampleFiles: { 'lookupFile': 'firstnames.txt' } },
  },
  FullName: {
    group: 'personal',
    description: 'Mascara nome completo separando primeiro(s) nome(s) e sobrenome, aplicando um algoritmo diferente em cada parte. O split é feito por espaço (ou pelos separadores configurados).',
    inputFormat: 'Nome completo com espaços. Ex: "João da Silva", "Maria Oliveira Santos".',
    params: {
      lastNameAtTheEnd: 'Define onde está o sobrenome. true = sobrenome é a última palavra (padrão brasileiro: "João da Silva" → sobrenome "Silva"). false = sobrenome é a primeira palavra (padrão anglo-saxão: "Silva João" → sobrenome "Silva").',
      ifSingleWordConsiderAsLastName: 'O que fazer quando o input tem apenas uma palavra. true = trata como sobrenome e aplica o lastNameAlgorithmRef. false = trata como primeiro nome e aplica o firstNameAlgorithmRef.',
      firstNameAlgorithmRef: 'Algoritmo aplicado ao(s) primeiro(s) nome(s). Informe o nome de uma instância do catálogo (ex: "dlpx-core:FirstName"). Se omitido, os primeiros nomes são preservados sem mascaramento.',
      lastNameAlgorithmRef: 'Algoritmo aplicado ao sobrenome. Informe o nome de uma instância do catálogo (ex: "dlpx-core:LastName"). Se omitido, o sobrenome é preservado sem mascaramento.',
      lastNameSeparators: 'Lista de strings que separam o sobrenome do(s) primeiro(s) nome(s), além do espaço padrão. Ex: ["-"] para tratar "Maria-Silva" como nome "Maria" e sobrenome "Silva". Útil para nomes com hífen ou outros delimitadores.',
      maxLengthOfMaskedName: 'Comprimento máximo do nome completo mascarado em caracteres. Se o resultado ultrapassar esse limite, o algoritmo trunca ou rejeita. Útil quando a coluna tem restrição de tamanho.',
      maxNumberFirstNames: 'Número máximo de primeiros nomes a mascarar. Se o input tiver mais nomes que esse limite, os excedentes são preservados sem mascaramento. Ex: "João Pedro Carlos Silva" com maxNumberFirstNames=1 → mascara só "João", preserva "Pedro Carlos".',
    },
    labels: {
      lastNameAtTheEnd: 'Sobrenome ao final',
      ifSingleWordConsiderAsLastName: 'Palavra única = tratar como sobrenome',
      firstNameAlgorithmRef: 'Algoritmo para o(s) primeiro(s) nome(s)',
      lastNameAlgorithmRef: 'Algoritmo para o sobrenome',
      lastNameSeparators: 'Separadores adicionais de sobrenome',
      maxLengthOfMaskedName: 'Comprimento máximo do nome mascarado',
      maxNumberFirstNames: 'Máximo de primeiros nomes a mascarar',
    },
    example: { config: { lastNameAtTheEnd: true, ifSingleWordConsiderAsLastName: true }, input: 'João da Silva Santos', key: 'chave-nome' },
  },
  FinancialIdBr: {
    group: 'personal',
    description: 'Mascara CPF (11 dígitos) e CNPJ (14 dígitos) gerando números sintéticos com dígitos verificadores válidos. Detecta automaticamente o tipo pelo comprimento numérico.',
    inputFormat: 'CPF com ou sem formatação: "123.456.789-09" ou "12345678909". CNPJ com ou sem formatação: "12.345.678/0001-90" ou "12345678000190".',
    params: {
      maskInvalidInput: 'O que fazer quando o CPF/CNPJ de entrada é inválido (dígitos verificadores incorretos ou comprimento errado). false = lança erro e interrompe (padrão). true = tenta mascarar do mesmo jeito, ignorando a invalidade.',
      cmNumericRef: 'Algoritmo de substituição de dígitos usado internamente para embaralhar os números do CPF/CNPJ. Se não configurado, usa o Character Mapping numérico padrão embutido. Informe o nome de uma instância de algoritmo do catálogo (ex: "dlpx-core:CM_Digits"). Deixe vazio para usar o padrão.',
      fallbackAlgorithm: 'Algoritmo aplicado quando o valor de entrada não é reconhecido como CPF nem CNPJ (ex.: campo está em branco ou contém texto fora do formato). Se não configurado, o algoritmo lança erro. Informe o nome de uma instância de algoritmo do catálogo para tratar esses casos graciosamente.',
    },
    labels: {
      maskInvalidInput: 'Mascarar mesmo se CPF/CNPJ inválido',
      cmNumericRef: 'Algoritmo de substituição de dígitos (Character Mapping)',
      fallbackAlgorithm: 'Algoritmo de fallback (formato não reconhecido)',
    },
    example: { config: { maskInvalidInput: false }, input: '123.456.789-09', key: 'chave-cpf' },
  },
  IBAN: {
    group: 'financial',
    description: 'Mascara número IBAN preservando o código do país e o dígito verificador.',
    inputFormat: 'IBAN no formato padrão. Ex: "GB29NWBK60161331926819"',
    params: { validateInput: 'Obrigatório. Valida o IBAN antes de mascarar.', numCharsToMask: 'Obrigatório. Número de caracteres a mascarar.' },
    labels: { validateInput: 'Validar IBAN antes de mascarar', numCharsToMask: 'Quantidade de caracteres a mascarar' },
    example: { config: { validateInput: true, numCharsToMask: 20 }, input: 'GB29NWBK60161331926819', key: 'chave-iban' },
  },
  Checkdigit: {
    group: 'other',
    description: 'Mascara os dígitos de um número que contém dígito verificador, recalculando o verificador após o mascaramento para que o resultado continue válido. Funciona para qualquer esquema baseado em soma ponderada + módulo (CPF, CNPJ, código de barras, EAN, etc.).',
    inputFormat: 'String numérica sem pontuação ou espaços. O comprimento deve incluir o dígito verificador na posição configurada. Ex: "12345678901" (CPF), "7891000315507" (EAN-13), "123456789012" (código de barras).',
    params: {
      weightList: 'Obrigatório. Lista de pesos aplicados a cada dígito na soma ponderada. Um peso por dígito que entra no cálculo (na ordem de leitura ou direita-para-esquerda, conforme calculateChecksumRightToLeft). Ex: EAN-13 usa [1,3,1,3,1,3,1,3,1,3,1,3].',
      modulusNumber: 'Obrigatório. Divisor usado no módulo da soma ponderada. O dígito verificador é normalmente (módulo − resto) % módulo. Ex: EAN-13 usa 10, CNPJ usa 11.',
      checkDigitIndex: 'Obrigatório. Posição do dígito verificador na string, contando a partir do índice 0 (da esquerda). Ex: para um código de 13 dígitos onde o verificador é o último, informe 12.',
      calculateChecksumRightToLeft: 'Obrigatório. Direção em que os pesos do weightList são aplicados sobre os dígitos. true = da direita para a esquerda (padrão de boletos e CNPJ). false = da esquerda para a direita (padrão de EAN/UPC).',
      numDigitsForCheckdigitCalculation: 'Obrigatório. Quantidade de dígitos usados na soma ponderada (excluindo o próprio dígito verificador). Deve ser igual ao comprimento do weightList. Ex: EAN-13 tem 12 dígitos de dados → informe 12.',
      swapModulusForZeroRemainder: 'Quando o resto da divisão for zero, usa o próprio modulusNumber como dígito verificador em vez de zero. Alguns padrões (ex: CNPJ) adotam essa regra. false = dígito verificador será 0 quando o resto for 0.',
      checksumCalculationType: 'Algoritmo de cálculo do checksum. STANDARD = soma ponderada simples módulo N (padrão). TFN = variante australiana (Tax File Number) com lógica de cálculo específica.',
      numericAlgorithm: 'Algoritmo de mascaramento aplicado aos dígitos que não são o verificador. Informe o nome de uma instância do catálogo (ex: "dlpx-core:CM_Digits"). Se omitido, usa o Character Mapping numérico padrão.',
      alphaNumericAlgorithm: 'Algoritmo de mascaramento usado quando a entrada contém letras além de números (alfanumérico). Substituído nos caracteres não numéricos antes do recálculo do verificador. Se omitido e a entrada tiver letras, pode lançar erro dependendo do characterHandling.',
      fallbackAlgorithm: 'Algoritmo aplicado quando a entrada é inválida e invalidInputHandling = FALLBACK_MASK. Recebe o valor original inteiro. Se omitido e ocorrer entrada inválida com FALLBACK_MASK, o comportamento é indefinido.',
      preserveRegex: 'Expressão regular que identifica partes da string a preservar sem mascarar (ex: prefixos fixos). Os trechos que casarem são mantidos intactos; o algoritmo mascara apenas o restante.',
      'inputHandlingConfig': 'Configurações de como tratar a entrada antes do mascaramento.',
      'inputHandlingConfig.characterHandling': 'Como tratar caracteres não numéricos na entrada. NUMERIC_ONLY = só aceita 0-9, rejeita todo o resto. STANDARD = letras são tratadas como seus valores ASCII normais. ASCII_VALUE_MINUS_48 = usa (valorASCII − 48) para letras, útil em alguns padrões que intercalam letras e dígitos.',
      'inputHandlingConfig.invalidInputHandling': 'O que fazer quando a entrada é inválida (comprimento errado, caracteres inesperados). ERROR = lança exceção (padrão). FALLBACK_MASK = delega ao fallbackAlgorithm em vez de falhar.',
      'inputHandlingConfig.shortInputHandling': 'O que fazer quando a entrada tem menos dígitos que o esperado. FALLBACK = delega ao fallbackAlgorithm. PAD_LEFT = completa com padCharacter à esquerda. PAD_RIGHT = completa com padCharacter à direita.',
      'inputHandlingConfig.padCharacter': 'Caractere usado para preencher entradas curtas quando shortInputHandling = PAD_LEFT ou PAD_RIGHT. Normalmente "0".',
      'inputHandlingConfig.trimWhitespace': 'Se verdadeiro, remove espaços e tabs das extremidades da entrada antes de processar. Útil quando os dados vêm com padding do banco.',
    },
    labels: {
      weightList: 'Lista de pesos (um por dígito de dados)',
      modulusNumber: 'Módulo (divisor da soma ponderada)',
      checkDigitIndex: 'Índice do dígito verificador (0-based)',
      calculateChecksumRightToLeft: 'Aplicar pesos da direita para a esquerda',
      numDigitsForCheckdigitCalculation: 'Quantidade de dígitos no cálculo (= tamanho do weightList)',
      swapModulusForZeroRemainder: 'Usar módulo quando resto for zero',
      checksumCalculationType: 'Tipo de cálculo do checksum',
      numericAlgorithm: 'Algoritmo para dígitos numéricos',
      alphaNumericAlgorithm: 'Algoritmo para caracteres alfanuméricos',
      fallbackAlgorithm: 'Algoritmo de fallback (entrada inválida)',
      preserveRegex: 'Regex de partes a preservar',
      inputHandlingConfig: 'Tratamento da entrada',
      'inputHandlingConfig.characterHandling': 'Tratamento de caracteres não numéricos',
      'inputHandlingConfig.invalidInputHandling': 'Ação para entrada inválida',
      'inputHandlingConfig.shortInputHandling': 'Ação para entrada curta',
      'inputHandlingConfig.padCharacter': 'Caractere de preenchimento',
      'inputHandlingConfig.trimWhitespace': 'Remover espaços das extremidades',
    },
    example: { config: { weightList: [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5], modulusNumber: 11, checkDigitIndex: 12, calculateChecksumRightToLeft: true, numDigitsForCheckdigitCalculation: 12 }, input: '123456789012', key: 'chave-check' },
  },
  Tokenization: {
    group: 'other',
    description: 'Substitui o valor por um token usando AES (Format-Preserving Encryption). O token tem o mesmo comprimento e tipo de caracteres do original (dígitos viram dígitos, letras viram letras). É reversível: com a mesma chave e configuração é possível recuperar o valor original — use o botão "Detokenizar" para isso.',
    inputFormat: 'String alfanumérica de formato fixo, como número de cartão de crédito (16 dígitos) ou CPF. Caracteres fora do conjunto tokenizável (símbolos, espaços) acionam o fallback configurado.',
    params: {
      fallback: 'O que fazer quando o valor contém caracteres que não podem ser tokenizados (ex.: "@", "-", espaços). NONE lança erro; CHARACTER_MAPPING substitui esses caracteres por uma máscara genérica e continua.',
      ivLength: 'Tamanho do vetor de inicialização AES em bytes (padrão: 8). Valores maiores aumentam a aleatoriedade do token, mas reduzem o espaço disponível para os dados.',
      cmCharacterGroups: 'Só relevante quando fallback = CHARACTER_MAPPING. Define quais caracteres são intercambiáveis entre si no fallback — ex.: ["0123456789", "abcdefghijklmnopqrstuvwxyz"] cria dois grupos separados. Se vazio, usa os grupos padrão do Character Mapping.',
      cmMinMaskedPositions: 'Só relevante quando fallback = CHARACTER_MAPPING. Número mínimo de posições que o fallback deve mascarar, mesmo que poucos caracteres sejam não-tokenizáveis. Evita que tokens com apenas 1 caractere substituído sejam fáceis de reverter.',
    },
    labels: {
      fallback: 'Ação de fallback para caracteres não-tokenizáveis',
      ivLength: 'Tamanho do vetor de inicialização (bytes)',
      cmCharacterGroups: 'Grupos de caracteres do fallback (Character Mapping)',
      cmMinMaskedPositions: 'Posições mínimas mascaradas pelo fallback',
    },
    reversible: true,
    example: { config: { fallback: 'CHARACTER_MAPPING', ivLength: 8 }, input: '4111111111111111', key: 'chave-aes-forte' },
  },
  MultiColumnAddress: {
    group: 'multiColumn',
    description: 'Mascara campos de endereço distribuídos em múltiplas colunas gerando endereços sintéticos coerentes. ⚠️ Requer arquivo de lookup de endereços — não testável no runner standalone sem esse arquivo. O algoritmo falha ao inicializar sem o arquivo configurado.',
    inputFormat: 'String representando um campo de endereço. Requer configuração de lookupFile com um banco de dados de endereços no formato específico do Delphix. Não funciona com config vazia.',
    example: { config: {}, input: 'Rua das Flores, 123', key: '' },
  },
  MultiColumnCondition: {
    group: 'multiColumn',
    description: 'Aplica algoritmos de mascaramento diferentes a múltiplas colunas dependendo do valor de uma coluna condicional ("key"). Ex: se GENERO="F", aplica FirstName em string1; se GENERO="M", aplica outro algoritmo. Cada condição define quais algoritmos usar para colunas de tipo string, numérico, data e binário.',
    inputFormat: 'Linha de banco de dados simulada com colunas nomeadas. Coluna obrigatória: "key" (valor da coluna condicional). Colunas opcionais: "string1"..."string10", "numeric1"..."numeric3", "date1"..."date3".',
    params: {
      conditions: 'Array de condições. Cada condição define: key (lista de valores que ativam esta condição), e os algoritmos a aplicar por slot (string1..10, numeric1..3, date1..3, binary1..3). Exemplo: key=["F"] + string1={name:"dlpx-core:FirstName"} mascara a coluna string1 com nomes femininos quando key="F".',
      'conditions.key': 'Lista de valores da coluna condicional que ativam esta condição. A comparação usa keyCaseSensitive para controlar case. Ex: ["F", "Female"] ativa para "F" ou "Female".',
      'conditions.string1': 'Algoritmo aplicado à coluna "string1" da linha quando esta condição é ativada. Informe o nome de uma instância do catálogo. Ex: {name: "dlpx-core:FirstName"}.',
      'conditions.string2': 'Algoritmo aplicado à coluna "string2" quando esta condição é ativada.',
      'conditions.numeric1': 'Algoritmo aplicado à coluna "numeric1" (BigDecimal) quando esta condição é ativada.',
      'conditions.date1': 'Algoritmo aplicado à coluna "date1" (LocalDateTime) quando esta condição é ativada.',
      'conditions.binary1': 'Algoritmo aplicado à coluna "binary1" (ByteBuffer) quando esta condição é ativada.',
      fallbackAlgo: 'Algoritmo aplicado às colunas string quando nenhuma condição casa com o valor de "key". Se não configurado, o valor é preservado sem mascaramento.',
      fallbackKey: 'Valor padrão usado como chave quando a coluna "key" está nula ou ausente.',
      keyCaseSensitive: 'Se verdadeiro, a comparação do valor de "key" com as listas em conditions.key é case-sensitive. Padrão: false.',
      filterLength: 'Comprimento máximo do valor "key" usado na comparação. Se o valor tiver mais caracteres, apenas os primeiros filterLength são usados.',
      filterDirection: 'De onde contar os caracteres para filterLength: LEFT (do início) ou RIGHT (do final).',
    },
    labels: {
      conditions: 'Condições',
      'conditions.key': 'Valores da coluna condicional',
      'conditions.string1': 'Algoritmo para coluna string1',
      'conditions.string2': 'Algoritmo para coluna string2',
      'conditions.numeric1': 'Algoritmo para coluna numeric1',
      'conditions.date1': 'Algoritmo para coluna date1',
      'conditions.binary1': 'Algoritmo para coluna binary1',
      fallbackAlgo: 'Algoritmo de fallback (sem condição casando)',
      fallbackKey: 'Chave padrão quando "key" é nulo',
      keyCaseSensitive: 'Comparação de chave sensível a maiúsculas',
      filterLength: 'Filtrar primeiros N caracteres da chave',
      filterDirection: 'Direção do filtro (LEFT / RIGHT)',
    },
    multiColumnMode: true,
    example: {
      config: {
        conditions: [
          { key: ['F'], string1: { name: 'dlpx-core:FirstName' } },
          { key: ['M'], string1: { name: 'dlpx-core:FirstName' } },
        ],
        keyCaseSensitive: false,
      },
      input: '',
      key: 'delphix-default-key',
      columns: [
        { name: 'key', type: 'STRING', value: 'F' },
        { name: 'string1', type: 'STRING', value: 'Maria' },
      ],
    },
  },
}

/** Locale-specific prose. pt-BR lives inline in METADATA above and acts as the
 *  fallback, so an entry missing from a translation still renders something. */
const TEXT_BY_LOCALE: Partial<Record<Locale, Record<string, AlgoText>>> = {
  'en': ALGO_TEXT_EN,
  'es': ALGO_TEXT_ES,
}

/** Resolves `className` to a METADATA key: exact, simple name, or case-insensitive. */
function resolveKey(className: string): string | null {
  if (!className) return null
  if (METADATA[className]) return className
  const simple = className.split('.').pop() ?? className
  if (METADATA[simple]) return simple
  const lower = simple.toLowerCase()
  for (const key of Object.keys(METADATA)) {
    if (key.toLowerCase() === lower) return key
  }
  return null
}

export function getAlgoMetadata(className: string, locale?: Locale): AlgoMetadata | null {
  const key = resolveKey(className)
  if (!key) return null
  const base = METADATA[key]
  const text = locale ? TEXT_BY_LOCALE[locale]?.[key] : undefined
  if (!text) return base
  // The example is merged field by field: a translation only spells out what changes.
  const example = base.example ? { ...base.example, ...text.example } : base.example
  return { ...base, ...text, example }
}

export function getAlgoGroup(className: string): AlgoGroup {
  const key = resolveKey(className)
  return (key && METADATA[key].group) || 'other'
}

// ── Non-determinism ───────────────────────────────────────────────────────────

/**
 * Which algorithms return a different output for the same input and key on every run.
 * Verified by executing each of the 31 five times; only these three ever varied.
 *
 * Two of them are non-deterministic only under a given configuration, so the check takes
 * the config: warning unconditionally would be wrong, and staying silent would let someone
 * pick Tokenization to preserve joins and find out much later that it does not.
 *
 * The message keys live in the i18n catalogs; the guide carries the same warning as a tag.
 */
const NON_DETERMINISTIC: Record<string, (config: Record<string, unknown>) => boolean> = {
  // Always: the permutation is drawn per run, by design.
  Shuffle: () => true,
  // A fresh AES initialization vector per call. `ivLength: 0` makes it deterministic.
  Tokenization: (cfg) => Number(cfg?.ivLength ?? 8) !== 0,
  // Only this hashMethod; SHA256 and LEGACY derive the row from the value and the key.
  SecureLookup: (cfg) => cfg?.hashMethod === 'RANDOMIZE',
}

/** i18n key explaining why this algorithm is non-deterministic, or null when it is not. */
export function nonDeterminismKey(
  className: string,
  config: Record<string, unknown>,
): 'tester.nonDetShuffle' | 'tester.nonDetTokenization' | 'tester.nonDetSecureLookup' | null {
  const simple = className.split('.').pop() ?? className
  if (!NON_DETERMINISTIC[simple]?.(config ?? {})) return null
  return simple === 'Shuffle' ? 'tester.nonDetShuffle'
    : simple === 'Tokenization' ? 'tester.nonDetTokenization'
    : 'tester.nonDetSecureLookup'
}
