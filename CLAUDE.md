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

## CI

`.github/workflows/checks.yml` roda em todo push para `main` e nas tags `v*`: tipos, build e
lint, os três bloqueantes.

**Antes de dar push, rode `npm run check`** — são as mesmas três verificações, localmente.

O que ele **não** cobre é a quarta que o CI faz: o `npm ci` exige `package.json` e
`package-lock.json` em sincronia, e falha inteiro se não estiverem. O `npm ci` não atualiza lock —
ele exige que já esteja certo, que é justamente o ponto dele.

**Ao regenerar o lock do frontend, gere para a plataforma do CI:**

```bash
rm frontend/package-lock.json
npm install --prefix frontend --package-lock-only --os=linux --cpu=x64
```

Sem `--os`/`--cpu`, o npm no macOS descarta as dependências opcionais que só o Linux usa (as
variantes `@rolldown/binding-*` e a árvore `@emnapi` do fallback WASM do Vite). O lock passa
localmente e quebra o CI com `Missing: … from lock file`. Foi o que derrubou dois pushes
seguidos: o primeiro por lock desatualizado, o segundo por lock gerado só para macOS.

Evite `--package-lock-only` sozinho para *criar* o lock do zero: ele resolve a seco e já produziu
uma árvore de opcionais incompleta (o `@napi-rs/wasm-runtime` presente sem as dependências dele).
Combinado com `--os`/`--cpu` sobre um lock apagado, funciona.

O workflow roda em **Node 24**, o mesmo do desenvolvimento — não o piso declarado de 22. Este job
compila e checa tipos, nunca executa o `server.js`, então a versão ali só decide qual npm lê o
lock, e majors diferentes escrevendo e lendo o mesmo arquivo é atrito à toa. Com um mantenedor commitando direto na `main`, é o que a revisão de
PR faria — e na tag ele funciona como portão, para um commit quebrado não virar release.

O `javac` do runner só roda se houver JARs em `lib/`; no CI não há, e ele pula com aviso.

**Estado derivado, não espelhado.** Vários campos do formulário guardavam uma cópia do prop em
`useState` e a ressincronizavam num `useEffect`. Isso é o que a regra `react-hooks/
set-state-in-effect` acusa, e a cópia só podia divergir: o pai é dono do valor e toda edição
passa por `onChange`. `ArrayField`, `ConditionArrayField` e `AlgorithmRefField` agora derivam do
prop direto. Em `TestCard`, a `key` inclui `updated_at`, então uma linha que volta alterada do
servidor remonta com o valor novo — que era o que o efeito fazia à mão.

Buscas de montagem que só levantavam um flag já inicializado em `true` foram embutidas no efeito;
o `load()` continua existindo para os refreshes explícitos, onde o spinner é desejado.

## Primeiro uso sem os JARs

Sem as bibliotecas do Delphix nada funciona — não há lista de algoritmos, nem execução, nem
catálogo para o assistente. `GET /api/setup` diz o que falta (`missingJars()`), e o `App.tsx`
renderiza `SetupNeeded.tsx` no lugar do app inteiro em vez de deixar a barra lateral vazia sem
explicação, que era o comportamento anterior: o `getAlgorithms()` engolia o erro e o usuário novo
não recebia pista nenhuma.

A tela diz **o que falta, onde colocar e como obter**, com o caminho absoluto de `lib/` copiável
e a lista dos prefixos ausentes. O botão de reverificar chama `/api/setup` de novo e entra no app
sem recarregar a página.

Se o `/api/setup` em si falhar, o app renderiza normalmente: um servidor que não responde é outro
problema, e prender o usuário numa tela de setup que não é a causa só atrapalha.

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

## Segredos

Ficam na tabela `config` do SQLite — a senha do engine e as chaves de IA — **em texto puro**.
Duas coisas os protegem:

1. `db/tests.db` é criado e mantido em `0600` (o servidor força na subida). Essa é a proteção
   que de fato se aplica a uma ferramenta local, e é a mesma postura de `~/.aws/credentials` ou
   `~/.npmrc`. Antes disso o arquivo estava `0644`, legível por qualquer conta da máquina.
2. Quem preferir não ter o segredo em disco define uma variável de ambiente; ela vence o banco:

   | Config | Variável |
   |---|---|
   | `delphix.password` | `DLPX_ENGINE_PASSWORD` |
   | `ai.anthropic.apiKey` | `DLPX_AI_ANTHROPIC_KEY` |
   | `ai.gemini.apiKey` | `DLPX_AI_GEMINI_KEY` |
   | `ai.copilot.apiKey` | `DLPX_AI_COPILOT_KEY` |

   Os nomes são namespaced de propósito: adotar `ANTHROPIC_API_KEY` do ambiente sem o usuário
   pedir seria uma surpresa desagradável.

**Cuidado ao mexer nisso:** `readConfig()` sobrepõe o ambiente por cima do banco e **não pode**
ser a base de uma escrita — `PUT /api/config` usa `readStoredConfig()`. Usar `readConfig()` ali
grava no arquivo justamente o segredo que a variável existia para manter fora dele. Foi o que
aconteceu na primeira versão.

**Não criptografamos o arquivo.** Com a chave morando ao lado do banco, num repositório público,
seria ofuscação e não proteção: quem lê o `.db` lê a chave. O que traria proteção real seria o
chaveiro do SO (Keychain / Credential Manager), e isso é decisão em aberto — ver as pendências
do repositório interno.

## Integração com uma instância Delphix

`delphix.js` importa e exporta algoritmos de um Masking Engine. Configuração em
**Configurações → Delphix** (`delphix.baseUrl`, `delphix.username`, `delphix.password`,
`delphix.allowSelfSigned`); a senha é mascarada na resposta da API igual às chaves de IA.

Contrato, lido do OpenAPI de uma instância (`/masking/api/swagger-basepath.json`):

- Base `{host}/masking/api` — **sem versão**. Verificado: a versionada `/v5.1.49` também
  responde, mas quebraria contra instância de outra versão; `/v5.1` e `/v5` dão 404.
- `POST /login` → `{Authorization: "<token>"}`; o header é o **token cru**, não `Bearer`.
- `POST /algorithms` cria, `PUT /algorithms/{algorithmName}` atualiza. Ambos devolvem
  `AsyncTask`, mas a alteração já está visível no `GET` seguinte — não é preciso poll.

**Duas armadilhas que o código contorna:**

1. `GET /algorithms` devolve `frameworkId` mas **não** `frameworkName`. Os frameworks são
   buscados à parte e casados por id. Ler o nome direto do algoritmo deixaria tudo sem
   identificação.
2. Nomes de framework **não são únicos entre plugins** — uma instância padrão tem `IBAN` do
   `dlpx-core` (id 50) e outro do plugin `IBAN` (id 40). A resolução exige
   `plugin.pluginName === 'dlpx-core'`, senão a exportação anexa o framework errado.

O mapa `className → frameworkName` no `delphix.js` foi **gerado do JAR do plugin**
(`MaskingComponent.getName()`), não digitado: os nomes divergem dos nossos rótulos de UI
(`Redact` → `Redact Input`, `Numeric Mapping` → `CM Numeric`, `Min/Max BigDecimal` →
`MinMax Number`).

**O nome é identidade, e não se renomeia.** `PUT /algorithms/{name}` com um `algorithmName`
diferente no corpo responde `"Cannot update 'algorithmName' field"`. A ferramenta segue a mesma
regra: o nome de um algoritmo salvo é definido ao criar ou ao **duplicar**, nunca editado. O
`PUT /api/tests/:id` ignora `name` de propósito, e a UI não tem campo para isso.

Dar um nome novo é duplicar: `POST /api/tests/:id/duplicate` com `{name}` copia a linha e a
deixa **sem vínculo** (`delphix_name`/`delphix_origin` nulos), porque a cópia é um algoritmo
novo e não outra visão do que já está no engine — enviá-la cria um lá. O endpoint recusa nome
vazio (`name-required`) e nome já usado (`name-taken`).

Linhas antigas podem ter nome local diferente do `delphix_name`, de antes desta regra; a
exportação atualiza o vinculado e devolve `renamed: true` para a UI avisar.

**Atualização parcial.** `PUT /api/tests/:id` só altera os campos presentes no corpo. Antes ele
usava `config || {}`, então atualizar apenas o input apagava a configuração — silenciosamente, e
a exportação seguinte falhava na validação do engine.

**Config vazia é recusada na atualização.** Uma linha local sem configuração sobrescreveria a do
engine com nada — perda de dados silenciosa. Antes de atualizar, compara-se: se a local está
vazia e a remota não, recusa com instrução de reimportar. Linhas salvas antes da correção de
dupla serialização guardam a config como *string* JSON; `parseStoredConfig()` no `server.js`
tolera as duas formas, como o frontend já fazia.

**Editar em vez de duplicar.** `saved_tests` ganhou `delphix_name` e `delphix_origin`. Só se
atualiza no lugar quando a linha veio *daquela* instância — o mesmo nome em outra instância é
outro algoritmo. Migração por `ALTER TABLE`, sem recriar a tabela.

**Arquivos ficam na instância; só a referência viaja.** Um arquivo enviado ao engine (lookup,
mapping) vive no file store dele, e o algoritmo guarda `delphix-file://upload/<id>/<nome>.txt`.
Importar traz a referência, nunca o conteúdo — foi o que produzia o `URI scheme is not "file"`
na primeira execução de um algoritmo importado.

O runner resolve isso em `resolveInputFile` (`AlgorithmRunner.java`): `file://` e caminho puro
como antes, `jar://file/` para os recursos embutidos no plugin, e **qualquer outro esquema pelo
nome do arquivo dentro de `FILES_DIR`** (`-Dfiles.dir`, que o `server.js` preenche com o
`filesDir` configurado). Não achando, sobe uma `MissingFileException` cuja mensagem diz o nome
esperado, a pasta, e que o resultado depende do arquivo — o plugin envolve essa mensagem, então
ela é o que aparece na tela.

O aviso também é dado **antes**: `delphix.engineFileNames()` varre a config importada atrás de
referências que o runner não resolve sozinho (qualquer esquema que não seja `file`/`jar`, em
qualquer profundidade, porque um sub-algoritmo pode ter a sua), e `missingEngineFiles()` no
`server.js` cruza com o conteúdo de `filesDir`. `GET /api/delphix/algorithms` devolve
`missingFiles` por linha e `POST /api/delphix/import` devolve `needsFiles`. A importação **não**
é bloqueada por isso: a linha está correta e exportar de volta funciona; o que falta é só para
executar aqui.

**A referência sobrevive ao round trip — menos por um caminho.** A config guardada nunca é
reescrita: o `PUT /api/tests/:id` só altera os campos que chegam, e a exportação manda
`parseStoredConfig(row.config)` inteiro. Então importar → testar com um txt local → ajustar
parâmetros → exportar devolve a referência `delphix-file://` intacta, e a instância continua
lendo o arquivo dela.

O que quebrava isso era o `FilePickerField` (`ConfigForm.tsx`): as opções do `<select>` são os
arquivos locais, nenhuma casa com o URI da instância, e um select controlado sem opção
correspondente renderiza **sem seleção** — o campo parecia vazio, e o reflexo de preenchê-lo
trocava a referência por um `file:///Users/…` que na instância não existe. Agora um URI fora da
lista vira opção própria, rotulada `form.fileOnEngine` (esquema não-`file`) ou `form.fileMissing`
(`file://` fora de `filesDir`), já selecionada, com aviso em âmbar embaixo. Trocar continua
possível — só deixou de ser acidente.

A exportação avisa, mas não recusa: `localFileUris()` no `delphix.js` acha os `file://` da config
e o endpoint devolve `localFiles`, que a UI mostra como toast. Recusar seria errado — um caminho
pode ser válido no host da instância, e só quem administra sabe.

Instâncias com plugin mais antigo não têm todos os frameworks (a de laboratório não tem Phone,
Shuffle, Redact Input, Repeat First Digit, Null Secure Lookup nem os Date Shift Discrete/
Variable). Exportar para elas falha com mensagem explicando; importar marca o algoritmo como
não suportado em vez de criar uma linha que nunca poderia ser executada.

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

## Regravar o demo.gif

`node docs/record-demo.mjs` dirige o app rodando em Chrome headless e escreve `docs/demo.gif`
com as três cenas: o assistente construindo um algoritmo, um algoritmo sendo testado, e a
sincronização com uma instância Delphix.

Precisa do app no ar (`npm run dev`), do Ollama para a cena 1 e de uma instância Delphix
configurada para a cena 3. O script força a interface para inglês durante a gravação e devolve o
idioma anterior no fim — o GIF aparece nos três READMEs e no site.

Sem ffmpeg e sem ImageMagick: o próprio Chrome decodifica e redimensiona cada captura no canvas,
e o `gifenc` quantiza. As duas dependências (`puppeteer-core`, `gifenc`) são `devDependencies` e
o `puppeteer-core` usa o Chrome já instalado, sem baixar Chromium.

Tamanho e nitidez saem de três constantes no topo do script: `VIEW`, `SCALE` e `COLORS`. Em
0.66/40 cores o resultado fica em torno de 1,3 MB.

**Espere por estado, não por tempo.** As esperas do script são condicionais (`waitFor`): listar
uma instância remota leva cerca de **oito segundos**, e um `sleep` fixo menor gravou um diálogo
vazio. A cena 1 espera o cartão verde de "algoritmo salvo" — esperar por um balão de mensagem
casava com a pergunta do próprio usuário e encerrava a cena na hora.

A gravação cria um algoritmo local (o que o assistente constrói) e importa um da instância.
Limpe-os depois, ou o GIF seguinte mostra "já importado".

## Instalador (`install.sh` / `install.ps1`)

Os canônicos ficam na **raiz** — é essa cópia que o launcher re-executa no `dlpx-helper update`.
O `docs/build-site.mjs` os copia para `docs/` a cada build, porque o Pages só serve aquela pasta
e é de lá que sai a URL do one-liner.

Eles instalam, atualizam e desinstalam. Node, Java e git são **verificados, nunca instalados**:
o script não mexe na toolchain da máquina. Os JARs do Delphix ele não tem como baixar — quem
explica isso é a tela de primeiro uso do app.

O launcher `dlpx-helper` é **gerado** pelo instalador (precisa saber o diretório) e reescrito a
cada update.

**Três armadilhas que já custaram caro aqui:**

1. **Heredoc sem aspas executa o conteúdo.** A primeira versão gerava o launcher com
   `<<LAUNCHER_EOF`, e as crases dos comentários viraram substituição de comando — o `npm start`
   rodou durante a geração e a saída do build foi parar dentro do arquivo. Agora o corpo vem de
   um heredoc **com aspas** e só o `APP_DIR` é injetado antes dele.
2. **`npm start` não pode ser o processo do PID.** O npm é pai de um shell que é pai do node, e
   o PID gravado era o do npm: parar deixava o servidor segurando a porta. O launcher roda
   `node server.js` direto, o que também evita recompilar o frontend a cada start.
3. **`curl | bash` deixa o stdin ocupado pelo script.** Prompts leem de `/dev/tty`, e a detecção
   testa **abrir** o dispositivo, não só permissão — ele pode existir e recusar abertura.

Sem terminal, o script usa os defaults e a desinstalação **recusa**: apagar sem confirmação
explícita não acontece.

`DLPX_REPO_URL` sobrescreve a origem do clone — serve para fork e para testar a partir de um
checkout local.

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

**Aviso de independência e licença.** Logo abaixo do hero, antes das capacidades: o projeto não
tem vínculo com a Delphix, e exige licença Delphix ativa porque os algoritmos vêm das bibliotecas
do produto. Fica ali de propósito — decide se a pessoa pode usar a ferramenta, então não é letra
miúda para se achar depois. A mesma coisa aparece no topo dos três READMEs e, em forma curta, nos
rodapés. Ao mexer no texto do site, os campos são `noticeTitle`, `noticeIndependent` e
`noticeLicense`, e os dois últimos **aceitam HTML** (`<strong>`), então são renderizados com
`raw()` e não com `esc()`.

**Posicionamento.** São quatro capacidades, não três: entender, testar, construir e **sincronizar**
com um Masking Engine. A sincronização tem seção própria na landing, porque é o que faz a
ferramenta cobrir a vida inteira de um algoritmo em vez de só a criação. Ao mexer no texto, os três
idiomas ficam lado a lado em `docs/site-content.mjs` com as mesmas chaves.

A landing tem a seção `#install` com o one-liner de cada sistema e um botão de copiar. O CTA
primário do hero aponta para ela. Os comandos ficam **empilhados**, não lado a lado: são longos e
duas colunas os cortavam no meio da URL. O botão de copiar fica na linha do rótulo, nunca por
cima do código.

O botão tem dois caminhos e um último recurso — `navigator.clipboard`, depois `execCommand` e,
se nada funcionar, ele **seleciona o comando** para a pessoa copiar à mão. A API moderna exige
contexto seguro e permissão, e rejeita em silêncio quando negada; sem fallback, o botão não
faria nada e não diria nada.

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

- `FileReference` suportado via URI `file:///caminho/absoluto` (requer `commons-codec-1.18.0.jar` em `lib/`).
  Referência de arquivo guardado numa instância (`delphix-file://…`) resolve pelo nome dentro de
  `filesDir` — ver "Arquivos ficam na instância" na seção de integração
- `MappingSetReference` não suportado (algoritmo Mapping requer banco)
- `EmbeddedGeneratorReference` não suportado
- `MaskValueMetadata` retorna null
