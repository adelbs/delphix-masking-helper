# Frontend — React + Vite + Tailwind

Frontend do Delphix Masking Helper. **Não rode comandos diretamente aqui** — use os scripts do diretório raiz.

## Stack

- **React 19** + **TypeScript**
- **Vite 8** (bundler + dev server)
- **Tailwind CSS v3** (estilização)
- **lucide-react** (ícones)
- **sonner** (toasts)

## Estrutura

```
src/
├── App.tsx                     # Raiz: estado global, roteamento de views, layout sidebar+main
├── types.ts                    # Interfaces TypeScript
├── index.css                   # Tailwind base + scrollbar customizada
├── lib/
│   ├── api.ts                  # Chamadas à API do Express (/api/*), incluindo o chat via SSE
│   ├── utils.ts                # cn() — merge de classes Tailwind com tailwind-merge
│   ├── algo-metadata.ts        # Estrutura, exemplos e textos pt-BR por algoritmo
│   ├── algo-knowledge.en.json  # Textos em inglês — compartilhado com o ai.js do servidor
│   ├── algo-text.en.ts         # Textos em inglês (lê o JSON acima) + exemplos localizados
│   ├── algo-text.es.ts         # Textos em espanhol + exemplos localizados
│   └── i18n/
│       ├── index.ts            # Catálogos, detecção de locale, useT()
│       ├── I18nProvider.tsx    # Provider do contexto
│       └── messages/           # en.ts (fonte das chaves), pt-BR.ts, es.ts
└── components/
    ├── Sidebar.tsx             # Lista de algoritmos com busca; mobile = overlay
    ├── WelcomeScreen.tsx       # Home: cabeçalho + chat com a IA
    ├── Chat.tsx                # Chat com a IA (streaming SSE, card de algoritmo salvo)
    ├── AlgoTester.tsx          # Painel principal: config (form/JSON) + execução + salvar
    ├── SavedTests.tsx          # Lista de testes salvos com busca, rerun e export/import
    ├── Settings.tsx            # Configurações: abas Geral, IA e Arquivos
    └── ConfigForm.tsx          # Formulário dinâmico gerado a partir do JSON Schema
```

## Desenvolvimento

```bash
# A partir do diretório raiz:
npm run dev       # Vite (porta 5173) + Express (porta 3000) em paralelo
npm run build     # Build de produção → frontend/dist/
```

O Vite proxy redireciona `/api/*` para `http://localhost:3000` automaticamente.

## Textos e traduções

Todo texto visível passa pelo `useT()`. As chaves vivem em `src/lib/i18n/messages/en.ts` — que é
a fonte da verdade: `pt-BR.ts` e `es.ts` são tipados como `Record<MessageKey, string>`, então
esquecer uma tradução é erro de compilação.

```tsx
const { t } = useT()
t('sidebar.settings')                    // texto simples
t('form.columnCount', { n: 3 })          // interpola {n}; com "|" escolhe singular/plural
tx('form.addFilesHint', { path: <b/> })  // interpola nós React
```

Os textos dos algoritmos (descrição, formato de entrada, params, labels) ficam separados por
idioma — veja a seção de i18n no `CLAUDE.md` da raiz.

## Adicionar metadados a um algoritmo

Edite `src/lib/algo-metadata.ts` (base pt-BR, também usada como fallback):

```ts
NomeDaClasse: {
  group: 'string',                       // id do grupo da sidebar
  description: 'O que o algoritmo faz.',
  inputFormat: 'Formato esperado do input.',
  params: { nomeDoCampo: 'Ajuda que aparece sob o label no formulário.' },
  labels: { nomeDoCampo: 'Rótulo do campo' },
  example: { config: { /* ... */ }, input: 'valor', key: 'chave' },
}
```

A chave é o **nome simples da classe** (último segmento do `className`). Depois acrescente as
versões em inglês e espanhol — as chaves de `params`/`labels` precisam bater nos três idiomas.

## ConfigForm — tipos suportados (JSON Schema)

| Tipo JSON Schema | Campo renderizado |
|---|---|
| `string` | `<input type="text">` |
| `integer` / `number` | `<input type="number">` |
| `boolean` | `<input type="checkbox">` |
| `enum` | `<select>` |
| `array` | Lista com botão Adicionar/Remover item |
| `object` com `properties` | Sub-formulário aninhado |
| `object` com `additionalProperties` | Editor de pares chave/valor |
| `object` genérico | `<textarea>` JSON |
| `FileReference` | Seletor dos arquivos do servidor |
| `AlgorithmInstanceReference` | Seletor de teste salvo + campo livre para nome do catálogo |
| Array de condições (MultiColumnCondition) | Editor dedicado de condições por slot de coluna |
