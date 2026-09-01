# Delphix Masking Helper

Companheiro local para o plugin de mascaramento do Delphix: ajuda a **entender** o comportamento
de cada framework, **testar** algoritmos contra valores reais e **construir** algoritmos já
configurados — sem instância do Masking Engine.

Licença: MPL-2.0. Os jars do Delphix não são distribuídos com o repositório (ver abaixo).

## Arquitetura

```
Browser → Vite dev server (5173) ──proxy /api──→ Node.js/Express (3000) → AlgorithmRunner.jar → delphix-algorithm-plugin.jar
Browser → Node.js/Express (3000, prod) ──────────────────────────────────→ AlgorithmRunner.jar → delphix-algorithm-plugin.jar

Chat  → Node.js/Express /api/chat (SSE) → ai.js → provedor (Ollama local | Anthropic | Gemini | GitHub Models)
                                            └───→ AlgorithmRunner.jar (monta o catálogo e valida o que a IA cria)
```

## Pré-requisitos

- Node.js 22+ (usa `node:sqlite` nativo)
- Java 11+
- Os jars do Delphix em `lib/` — **não versionados** (ver abaixo)

## Bibliotecas do Delphix em `lib/`

Os jars são arquivos licenciados do produto Delphix e **não vão para o repositório**
(`lib/*.jar` está no `.gitignore`). Quem clona precisa pedir o Masking Devkit (SDK) à Delphix e
copiar 15 jars de `sdkTools/lib/` — a lista e a função de cada um estão em `lib/README.md`.

Nada no código referencia um nome de arquivo fixo: `findPluginJar()` procura por prefixo
(`delphix-algorithm-plugin*`) e `REQUIRED_JARS` também casa por prefixo, então qualquer versão do
SDK serve. `DLPX_PLUGIN_JAR` sobrescreve a busca. Faltando algum jar, o servidor avisa na subida
(`missingJars()`) e o `runJava` rejeita com `SETUP_HINT` em vez de estourar um stack do Java.

Os 15 obrigatórios foram determinados empiricamente, removendo um jar por vez e rodando uma
bateria dos 6 comandos do runner. Três jars que estavam em `lib/` não são necessários e ficaram
de fora da lista: `commons-lang3`, `jackson-module-jaxb-annotations` e `javax.annotation-api`.

## Iniciar

```bash
npm run dev    # desenvolvimento: Express + Vite em paralelo → acesse http://localhost:5173
npm start      # produção: build do frontend + Express → acesse http://localhost:3000
npm run build  # só compila o frontend (gera frontend/dist/)
```

## Estrutura

```
├── server.js                      # API Express + serve frontend/dist/ em produção
├── ai.js                          # Assistente de IA: provedores, catálogo e system prompt
├── package.json                   # Scripts raiz (usa concurrently para dev)
├── java-runner/
│   ├── AlgorithmRunner.java       # Carrega e executa algoritmos via reflection
│   └── AlgorithmRunner.jar        # Compilado (não editar diretamente)
├── lib/                           # JARs do Delphix — não versionados; ver lib/README.md
├── frontend/                      # React + Vite + Tailwind + TypeScript
│   ├── src/
│   │   ├── App.tsx                # Raiz: estado global, roteamento de views, layout
│   │   ├── types.ts               # Interfaces TypeScript (Algorithm, SavedTest, JsonSchema…)
│   │   ├── lib/
│   │   │   ├── api.ts             # Todas as chamadas à API do Express
│   │   │   ├── utils.ts           # cn() para merge de classes Tailwind
│   │   │   ├── algo-metadata.ts   # Estrutura + exemplos + textos pt-BR por algoritmo
│   │   │   ├── algo-knowledge.en.json  # Textos em inglês — compartilhado com o ai.js
│   │   │   ├── algo-text.en.ts    # Textos dos algoritmos em inglês (lê o JSON acima)
│   │   │   ├── algo-text.es.ts    # Textos dos algoritmos em espanhol
│   │   │   └── i18n/
│   │   │       ├── index.ts       # Catálogos, detecção de locale, useT()
│   │   │       ├── I18nProvider.tsx
│   │   │       └── messages/      # en.ts (fonte das chaves), pt-BR.ts, es.ts
│   │   └── components/
│   │       ├── Sidebar.tsx        # Lista de algoritmos com busca
│   │       ├── LocaleFlags.tsx    # Troca de idioma por bandeiras (rodapé da sidebar)
│   │       ├── AlgoDoc.tsx        # Aba Documentação: a seção do guia daquele algoritmo
│   │       ├── WelcomeScreen.tsx  # Home: cabeçalho + chat com a IA
│   │       ├── Chat.tsx           # Chat com a IA (streaming SSE)
│   │       ├── AlgoTester.tsx     # Painel principal de teste (config + execução)
│   │       ├── SavedTests.tsx     # Painel de testes salvos
│   │       ├── ConfigForm.tsx     # Formulário dinâmico gerado via JSON Schema
│   │       └── Settings.tsx       # Configurações: Geral, IA e Arquivos
│   ├── dist/                      # Build de produção (gerado por npm run build)
│   ├── vite.config.ts             # Proxy /api → Express porta 3000
│   └── vite-plugin-algo-guide.ts  # Serve o guia de docs/src/ como virtual:algo-guide/<locale>
├── db/
│   └── tests.db                   # SQLite com testes salvos
└── docs/                          # Guia de referência dos algoritmos (PDF, 3 idiomas)
    ├── build.sh                   # Regera os PDFs via Chrome headless
    ├── delphix-algorithms-guide.{pt-BR,en,es}.pdf
    └── src/
        ├── guide.css              # Estilo compartilhado pelos 3 idiomas
        └── guide.{pt-BR,en,es}.html
```

## Recompilar o AlgorithmRunner

Necessário apenas ao modificar `AlgorithmRunner.java`:

```bash
cd java-runner
javac -cp "$(ls ../lib/*.jar | tr '\n' ':')" AlgorithmRunner.java
jar cfe AlgorithmRunner.jar AlgorithmRunner *.class
```

## Assistente de IA

A Home tem um chat que explica algoritmos e cria algoritmos já configurados. O que ele cria é
salvo em **Testes/Algoritmos Salvos**.

**Fluxo.** O `ai.js` monta um system prompt com o catálogo dos 31 algoritmos: a prosa vem de
`frontend/src/lib/algo-knowledge.en.json` (o mesmo arquivo que a UI usa em inglês) e a lista de
parâmetros vem do **JSON Schema real** do plugin, buscado do `AlgorithmRunner`. Os schemas do
plugin não trazem descrição — só nome, tipo, enum e obrigatoriedade — por isso as duas metades
são necessárias. O catálogo custa um fork da JVM por algoritmo, então é montado uma vez e
mantido em memória; o aquecimento roda em background na subida do servidor (~5 s, ~47 KB).

**Criação de algoritmo.** O modelo devolve um bloco `<save-algorithm>` com JSON. O servidor
**executa o algoritmo de verdade** com essa configuração antes de salvar: se o runner recusar
(parâmetro inexistente, config inválida), nada é gravado e o erro aparece no chat. É o que
impede uma configuração alucinada de virar um teste salvo.

**Provedores.** `ollama` (padrão, local), `anthropic`, `gemini` e `copilot`. Configuráveis em
**Configurações → IA**; as chaves ficam no SQLite e a API devolve mascaradas (`publicConfig`),
com um flag `<chave>.set` para a UI saber que existe uma. `copilot` é o **GitHub Models**
(`https://models.github.ai/inference`, compatível com OpenAI, autenticado por PAT) — o GitHub
Copilot não expõe API de chat para aplicações de terceiros.

**Endpoints.** `POST /api/chat` recebe `{messages}` e devolve SSE com os eventos `delta` (texto),
`replace` (texto final sem o bloco de criação), `saved`, `save-error`, `warn`, `error` e `done`.
`GET /api/ai/status` diz se o provedor está acessível (e, no Ollama, lista os modelos instalados).

Todos os provedores fazem streaming e implementam o mesmo contrato
(`stream({ cfg, system, messages, onDelta, signal })`). Para adicionar um provedor, acrescente
uma entrada em `PROVIDERS` e um streamer em `STREAMERS`.

O catálogo ocupa ~12k tokens de contexto — folgado para Claude e Gemini, apertado para modelos
locais pequenos. Se um modelo do Ollama vier com contexto de 8k, ele trunca o catálogo e erra a
escolha do algoritmo.

## Chave de mascaramento

`MASKING_KEY`, no topo do `server.js`, é uma constante do projeto — não é configuração. Não sai no
`GET /api/config`, o `PUT` ignora `globalKey`, e `/api/mask`, `/api/mask-batch` e
`/api/mask-multicolumn` descartam qualquer `key` que venha no corpo: o servidor é a única
autoridade. Não há campo para ela na UI.

Todo algoritmo determinístico deriva a saída dela, então trocá-la muda todo valor que a ferramenta
produz, inclusive os pares entrada → saída do guia e da aba Documentação. Não troque sem regerar
essa documentação.

## Algoritmos não determinísticos

Três, verificados executando os 31 cinco vezes com a mesma entrada e chave — e dois deles só sob
certa configuração:

| Algoritmo | Quando | Como tornar determinístico |
|---|---|---|
| Shuffle | sempre | não dá — a permutação é sorteada por design |
| Tokenization | `ivLength` > 0 (padrão `8`) | `ivLength: 0` (continua reversível) |
| Secure Lookup | `hashMethod: RANDOMIZE` | `SHA256` ou `LEGACY` |

A UI avisa com uma faixa âmbar acima da configuração (`AlgoTester`), e o aviso **acompanha a
config**: editar `ivLength` ou `hashMethod` faz a faixa aparecer e sumir na hora. A regra está em
`nonDeterminismKey()` no `algo-metadata.ts` — um predicado por algoritmo, não uma lista fixa,
justamente porque dois deles dependem de parâmetro.

Nos guias o mesmo aviso é a tag `.tag-nondet` (com `⚠`), e o apêndice A traz a tabela acima. Ao
mexer nisso, mantenha os dois lados alinhados: são fontes independentes.

## Aba de documentação

Cada algoritmo abre com duas abas: **Testar** (padrão) e **Documentação**. A segunda mostra a
seção daquele algoritmo no guia de referência — o mesmo conteúdo dos PDFs.

O conteúdo **não é duplicado**. O plugin `frontend/vite-plugin-algo-guide.ts` lê
`docs/src/guide.<locale>.html` em tempo de build, recorta os blocos `.algo` e os expõe como o
módulo virtual `virtual:algo-guide/<locale>`, indexado por `className` (o `<span class="algo-cls">`
de cada bloco é a chave de junção). Não existe arquivo gerado em disco, então a aba e o PDF não
têm como divergir: editar o guia muda os dois, e em dev o `handleHotUpdate` do plugin atualiza a
aba aberta na hora.

São três chunks, um por idioma, carregados sob demanda (`frontend/src/lib/algo-guide.ts`) — o
bundle principal não carrega o guia.

O `AlgoDoc.tsx` injeta o HTML do bloco com `dangerouslySetInnerHTML`. É conteúdo do próprio
repositório lido em build, nunca entrada de usuário. Os atributos `style` inline são removidos na
extração, porque são tamanhos de impressão em `pt`; o restante das classes do guia (`.algo-desc`,
`.label`, `.fmt`, `.xf`, `.p-row`, `.note`…) é restilizado para tela no bloco `.algo-doc` do
`frontend/src/index.css`.

Ao adicionar um algoritmo, dê a ele um bloco `.algo` nos três guias — sem isso a aba mostra
"ainda não há seção do guia para este algoritmo".

## Idiomas da interface (i18n)

A UI existe em inglês, português (BR) e espanhol. A preferência fica em `config.locale`
no SQLite (`'auto' | 'en' | 'pt-BR' | 'es'`, padrão `'auto'` = idioma do navegador) e é
espelhada em `localStorage` para que a primeira renderização já saia no idioma certo.
O usuário troca pelas bandeiras no rodapé da barra lateral (`LocaleFlags.tsx`), que aplicam
na hora: o clique chama `applyLocalePref` e dispara o `PUT /api/config` sozinho, sem botão de
salvar. As bandeiras são SVG inline em vez de emoji, porque emoji de indicador regional não
renderiza como bandeira no Windows — degrada para o par de letras ("BR", "ES"). A bandeira ativa
é `resolveLocale(pref)`, então sob `'auto'` a detectada aparece marcada (anel cinza em vez de
azul); com um idioma fixado, aparece um link `auto` que volta a seguir o navegador.

Duas camadas de texto:

- **Chrome da interface** — `frontend/src/lib/i18n/messages/`. `en.ts` é a fonte das
  chaves; `pt-BR.ts` e `es.ts` são tipados como `Record<MessageKey, string>`, então uma
  chave faltando vira erro de compilação. Nos componentes: `const { t } = useT()`.
  `t('chave', { n })` interpola `{n}` e, se a mensagem tiver `|`, escolhe singular/plural.
  Para mensagens com marcação inline use `tx('chave', { nome: <code>…</code> })`.

- **Textos dos algoritmos** — `description`, `inputFormat`, `params`, `labels` e
  `example`. O pt-BR fica inline em `algo-metadata.ts` (também é o fallback); inglês e
  espanhol ficam em `algo-text.en.ts` e `algo-text.es.ts`, que sobrescrevem apenas esses
  campos. `getAlgoMetadata(className, locale)` faz o merge. As chaves de `params`/`labels`
  são caminhos com ponto dentro do JSON Schema — precisam ser idênticas nos três idiomas.

- **Exemplos** — o `example` é mesclado campo a campo: a tradução declara só o que muda
  (`input`, `key`, `columns`, `batchRows`, `sampleFiles`, `config`), o resto é herdado do
  pt-BR. Exemplos que dependem de arquivo de lookup apontam para a variante do idioma
  (`firstnames.en.txt`, `mapping.es.csv`…), definidas em `SAMPLE_FILES` no `server.js`.
  Ao adicionar um arquivo de amostra, crie as três variantes.

  Os guias em `docs/` acompanham esses exemplos: cada idioma usa seus próprios valores e
  suas próprias saídas. Ao mudar um exemplo, atualize o guia daquele idioma.

Ao adicionar um algoritmo ou parâmetro, atualize os três. Para conferir a paridade das
chaves antes de commitar, compare `params`/`labels` de cada algoritmo entre
`algo-metadata.ts`, `algo-text.en.ts` e `algo-text.es.ts`.

Os nomes dos grupos da sidebar são ids estáveis (`personal`, `dates`, `numeric`, …) em
`GROUP_ORDER`; o rótulo visível vem das chaves `group.*` do catálogo.

## Adicionar metadados a um algoritmo

Em `frontend/src/lib/algo-metadata.ts`, adicione uma entrada usando o nome simples da classe:

```ts
NomeDaClasse: {
  description: 'O que o algoritmo faz.',
  inputFormat: 'Formato esperado.',
  params: { campo: 'Descrição do parâmetro (aparece abaixo do label no form).' },
  example: { config: {}, input: 'valor', key: '' }
}
```

A chave é o nome simples da classe (último segmento do `className`). O lookup também aceita `className` completo ou variação case-insensitive. O bloco acima é o pt-BR — acrescente as versões em inglês e espanhol em `algo-text.en.ts` e `algo-text.es.ts` com as mesmas chaves de `params`/`labels`.

## Site (GitHub Pages)

O site vive em `docs/`, que é a pasta que o GitHub Pages serve quando configurado como *deploy
from branch → /docs*. Seis páginas geradas, duas por idioma:

```
docs/index.html            landing em inglês (raiz do site)   docs/algorithms.html
docs/index.pt-BR.html      landing em português                docs/algorithms.pt-BR.html
docs/index.es.html         landing em espanhol                 docs/algorithms.es.html
docs/site.css  docs/favicon.svg  docs/.nojekyll
```

**Não edite esses HTML à mão** — são gerados por `docs/build-site.mjs` e sobrescritos. O texto de
marketing está em `docs/site-content.mjs` (as três línguas lado a lado, mesmas chaves); o conteúdo
dos algoritmos vem de `docs/src/guide.<locale>.html`, o mesmo fonte dos PDFs e da aba Documentação
do app. As três superfícies leem o guia pelo mesmo parser, `docs/guide-parser.mjs`.

`./docs/build.sh` regenera PDFs **e** site. Rode-o depois de mexer no guia, senão o site fica
citando uma versão antiga.

**Divisão de conteúdo.** A landing é deliberadamente não técnica: diz para que serve e para quem,
e manda quem quer jars, portas e passos de build para o README. Detalhe técnico não sobe para lá.
A página de algoritmos carrega a referência completa — é o material do guia.

Pendência: as orientações de download e instalação entram nas landings quando houver a primeira
release. Ainda não há seção para isso; a CTA hoje aponta para o repositório.

## Editar o guia dos algoritmos

Os fontes ficam em `docs/src/`: um HTML por idioma (`guide.pt-BR.html`, `guide.en.html`, `guide.es.html`) e um `guide.css` compartilhado pelos três. Cada algoritmo é um bloco `.algo` com a mesma estrutura nos três idiomas — ao alterar conteúdo, aplique a mudança nos três arquivos.

Regerar os PDFs:

```bash
./docs/build.sh            # todos os idiomas
./docs/build.sh pt-BR      # apenas um
```

O build usa Chrome headless com CSS de impressão (A4). A tipografia depende de fontes do macOS (Iowan Old Style, Seravek, Menlo) — em outro SO os PDFs saem com fallback.

Ao alterar o layout, verifique a largura útil de A4 (176 mm ≈ 665 px) antes de gerar o PDF, porque o `@page` só se aplica na impressão e overflow horizontal não aparece na visualização em tela:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --window-size=665,1500 --screenshot=/tmp/check.png docs/src/guide.pt-BR.html
```

Os pares entrada → saída do guia foram gerados executando os algoritmos no `AlgorithmRunner`. Se um exemplo mudar, execute o algoritmo de verdade em vez de estimar a saída.

Desde a localização dos exemplos, os três guias **não** são mais traduções linha a linha: a estrutura dos blocos `.algo` continua idêntica, mas cada idioma tem seus próprios valores de entrada, suas próprias chaves e, portanto, suas próprias saídas. As chaves usadas são as mesmas do `example` da UI daquele idioma (`chave-email` / `email-key` / `clave-email` etc.), então uma saída do guia pode ser reproduzida carregando o exemplo correspondente na UI.

Duas linhas não são reproduzíveis e precisam de cuidado ao serem regeradas:

- **Shuffle (§4.6)** é não determinístico por design — qualquer permutação válida serve, desde que o conjunto de saída seja igual ao de entrada e nenhuma linha caia em si mesma.
- **Tokenization (§9.2)** usa um vetor de inicialização aleatório: cada execução gera um token diferente para a mesma entrada e chave. O token mostrado é apenas uma amostra; o que precisa valer é o par com a linha `REIDENTIFY`, que deve reverter exatamente aquele token.

## Limitações do runner standalone

- `FileReference` suportado via URI `file:///caminho/absoluto` (requer `commons-codec-1.18.0.jar` em `lib/`)
- `MappingSetReference` não suportado (algoritmo Mapping requer banco)
- `EmbeddedGeneratorReference` não suportado
- `MaskValueMetadata` retorna null
