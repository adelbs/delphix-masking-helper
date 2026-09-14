# Delphix Masking Helper

[English](README.md) · **Português (BR)** · [Español](README.es.md)

🌐 **[Site](https://adelbs.github.io/delphix-masking-helper/index.pt-BR.html)** — o que a ferramenta faz, e a referência completa dos frameworks, em três idiomas.

Um companheiro local para o plugin de mascaramento do Delphix, cobrindo a vida inteira de um
algoritmo. Ajuda a **entender** como cada um dos 31 frameworks de mascaramento se comporta,
**testar** um algoritmo contra valores reais, **construir** um algoritmo já configurado a partir
de um problema descrito em linguagem natural e **sincronizar** com um Masking Engine — trazendo os
algoritmos dele para trabalhar e devolvendo os seus. Tudo sem precisar criar um Rule Set nem
executar um masking job.

> **A nomenclatura segue a da Delphix.** Um **framework** é uma técnica de mascaramento que o
> plugin oferece — Secure Lookup, Character Mapping, Date Shift. Configurar um produz um
> **algoritmo**: com nome, salvo e pronto para usar. A barra lateral lista frameworks; o que você
> salva é um algoritmo.

> ### Projeto independente, e exige licença Delphix ativa
>
> **Sem qualquer relação com a Delphix.** Este é um projeto open source independente. Não é feito,
> endossado, revisado nem suportado pela Delphix ou por seus detentores, e nada aqui é produto
> oficial. Delphix e os nomes de produto citados são marcas de seus respectivos donos.
>
> **É necessária uma licença Delphix ativa.** Os frameworks de mascaramento vivem em jars
> licenciados do produto Delphix, que **não** são distribuídos aqui — este projeto não os
> entrega nem os substitui. Você já precisa ter direito a eles e conseguir o Masking Devkit (SDK)
> com a Delphix, normalmente por meio de uma licença ativa e do seu time de conta. Coloque quinze
> jars em `lib/` — veja [Bibliotecas do Delphix](#bibliotecas-do-delphix) abaixo. Referência: [Compliance Algorithm SDK](https://portal.perforce.com/s/article/Compliance-Algorithm-SDK-for-Guidewire-1728062704114).

![O assistente construindo um algoritmo, um algoritmo sendo testado, e algoritmos sendo sincronizados com uma instância Delphix](docs/demo.gif)

<sub>Três coisas, nesta ordem: pedir um algoritmo ao assistente e vê-lo construir e validar um;
executar um algoritmo com um valor real; importar de uma instância Delphix e devolver um. Gravado
com o provedor local padrão (Ollama · `llama3.1:8b`) num M1 Pro — a resposta do modelo está
acelerada, porque localmente leva cerca de um minuto. Todos os valores mascarados são saída real
do plugin, e a instância é real.</sub>

## Como funciona

O servidor Node expõe uma API REST que delega cada operação para o `AlgorithmRunner.jar`, que carrega e executa os frameworks via reflection. O frontend React é servido pelo Vite em desenvolvimento (com hot-reload) e pelo Express em produção.

## Guia dos frameworks

📖 **[Ler a referência dos frameworks online](https://adelbs.github.io/delphix-masking-helper/frameworks.pt-BR.html)** — o mesmo conteúdo dos PDFs, em três idiomas.

Cada framework abre com duas abas: **Testar** e **Documentação**. A aba de documentação mostra a
seção daquele framework no guia de referência, no idioma da interface — o mesmo conteúdo dos PDFs
abaixo, lido da mesma fonte, então os dois nunca divergem.

A tela de classifiers tem a mesma aba **Documentação**: ela abre com como o profiling decide um
domínio, seguida da seção do framework de classifier em questão.

O diretório [`docs/`](docs/) contém um guia de referência dos 31 frameworks do plugin, em três idiomas:

| Idioma | Arquivo |
|---|---|
| Português (BR) | [`docs/delphix-frameworks-guide.pt-BR.pdf`](docs/delphix-frameworks-guide.pt-BR.pdf) |
| English | [`docs/delphix-frameworks-guide.en.pdf`](docs/delphix-frameworks-guide.en.pdf) |
| Español | [`docs/delphix-frameworks-guide.es.pdf`](docs/delphix-frameworks-guide.es.pdf) |

Para cada framework o guia traz o que ele faz, exemplos de entrada → saída, e a explicação de todos os parâmetros de configuração. Os frameworks são agrupados pelas mesmas categorias da barra lateral da UI. A Parte 10 trata da descoberta de dado sensível: como um domínio é decidido, e os frameworks de classifier `PATH`, `TYPE`, `REGEX` e `LIST`. Há ainda três apêndices: conceitos transversais (determinismo, papel da chave, frameworks que podem não mascarar nada), o catálogo dos 59 algoritmos `dlpx-core:` embutidos no plugin, e as limitações do runner standalone.

Todos os pares entrada → saída foram gerados executando os frameworks no `AlgorithmRunner` — não são ilustrativos.

### Regerar os PDFs

Os fontes ficam em `docs/src/` (um HTML por idioma + `guide.css` compartilhado). Após editar, recompile:

```bash
./docs/build.sh            # todos os idiomas
./docs/build.sh pt-BR es   # apenas os idiomas informados
```

O build usa Chrome headless e fontes instaladas no macOS (Iowan Old Style, Seravek, Menlo), então os PDFs devem ser regerados em um Mac para manter a tipografia.

## Bibliotecas do Delphix

O tester executa os algoritmos de verdade do plugin de mascaramento do Delphix, então precisa de
alguns jars do produto. **Eles não são distribuídos neste repositório** — são arquivos
licenciados da Delphix. Você fornece uma vez, na sua máquina.

1. Solicite à Delphix o **Masking Devkit (SDK)** correspondente à sua versão do Masking Engine,
   pelo seu time de conta ou pelo portal de suporte. A Delphix documenta o SDK aqui:
   [Compliance Algorithm SDK](https://portal.perforce.com/s/article/Compliance-Algorithm-SDK-for-Guidewire-1728062704114).
2. Descompacte e copie estes quinze jars de `sdkTools/lib/` para [`lib/`](lib/):

| | |
|---|---|
| `delphix-algorithm-plugin-*.jar` | `masking-extensibility-api-*.jar` |
| `jackson-annotations-*.jar` | `jackson-core-*.jar` |
| `jackson-databind-*.jar` | `jackson-datatype-jdk8-*.jar` |
| `jackson-datatype-jsr310-*.jar` | `jackson-module-jsonSchema-*.jar` |
| `guava-*.jar` | `failureaccess-*.jar` |
| `ant-*.jar` | `commons-codec-*.jar` |
| `commons-compiler-*.jar` | `commons-lang-*.jar` |
| `janino-*.jar` | |

As versões não precisam ser específicas — o servidor casa por prefixo do nome do arquivo, então
o que vier no seu SDK serve. O resto de `sdkTools/lib/` pertence ao CLI do próprio SDK e não é
necessário; copiar tudo também funciona, só infla o classpath.

Se faltar algum jar, o servidor avisa na subida dizendo o que não encontrou, e a UI mostra a
mesma mensagem em vez de falhar em silêncio. Para apontar para um plugin fora de `lib/`, defina
`DLPX_PLUGIN_JAR` com o caminho completo.

Veja [`lib/README.md`](lib/README.md) para saber a função de cada jar.

## Instalação

**macOS / Linux**

```bash
curl -fsSL https://adelbs.github.io/delphix-masking-helper/install.sh | bash
```

**Windows** — no PowerShell, não no Prompt de Comando: `irm` é um comando do PowerShell, e o
`cmd.exe` responde `'irm' is not recognized`.

```powershell
irm https://adelbs.github.io/delphix-masking-helper/install.ps1 | iex
```

Se aparecer `Could not create SSL/TLS secure channel`, o PowerShell está negociando TLS 1.0, que
o GitHub não aceita mais — Windows mais antigos, o Server 2016 entre eles. Rode isto antes, na
mesma janela, e depois a linha acima:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
```

Prefere ler antes de executar? É a mesma coisa em dois passos:

```bash
curl -fsSL https://adelbs.github.io/delphix-masking-helper/install.sh -o install.sh
less install.sh && bash install.sh
```

O script pergunta onde instalar, confere se Node, Java e git estão presentes — ele nunca os
instala, apenas avisa o que falta —, clona a release mais nova, compila e coloca o comando `dlpx-helper`
no seu PATH.

| | |
|---|---|
| `dlpx-helper` | sobe e abre o navegador |
| `dlpx-helper stop` | derruba |
| `dlpx-helper status` | está rodando? |
| `dlpx-helper version` | qual versão está instalada |
| `dlpx-helper logs` | acompanha o log |
| `dlpx-helper update` | vai para a release mais nova e recompila |
| `dlpx-helper uninstall` | remove (pergunta antes) |

### Em que versão eu estou?

Três lugares dizem, e nenhum deles acessa a rede:

- o **rodapé da barra lateral**, embaixo das bandeiras de idioma;
- **Configurações → Geral → Sobre**, com o commit e o comando de atualização;
- `dlpx-helper version` no terminal, mais a linha que o servidor imprime ao subir.

O número vem da tag git do checkout, então é a release que você tem de fato — `v1.0.3` numa
release, `v1.0.3-5-gabc1234` quando o código está à frente da última tag, e com `-dirty` no fim
quando há alterações não commitadas. Sem git, cai para a versão declarada no `package.json`, que
pode estar atrasada.

**Não há verificação de atualização.** A ferramenta diz o que você tem, nunca o que existe em
outro lugar; `dlpx-helper update` é como você descobre — rodando. Isso mantém a mesma promessa do
modelo local padrão: nada sai da sua máquina sem você pedir.

**A instalação fica presa a uma release, não à ponta da `main`.** O script pergunta ao remoto
qual a tag `vX.Y.Z` mais nova e faz checkout dela, então um commit enviado depois da última
release não chega até você; tags de pré-lançamento como `v2.0.0-rc1` também são ignoradas. Para
sobrescrever, use `DLPX_REF` — `DLPX_REF=v1.0.0` fixa uma release anterior, e um nome de branch
faz seguir aquele branch. Se o repositório não tiver tag de release nenhuma, o script cai no
branch padrão e avisa.

Rodar o script de novo numa máquina que já tem instalação oferece **atualizar** ou **remover**.
Atualizar nunca toca em `db/`, onde ficam seus algoritmos salvos e configurações. Desinstalar
apaga tudo, por isso avisa antes — copie a pasta `db/` para outro lugar se quiser guardar o que
está nela.

### Ou faça na mão

O script não faz nada que você não possa fazer sozinho:

```bash
git clone https://github.com/adelbs/delphix-masking-helper.git
cd delphix-masking-helper
npm install && npm install --prefix frontend
npm run build
npm start          # http://localhost:3000
```

De um jeito ou de outro, o último passo é o mesmo e só você pode dar: copiar os jars do seu
Masking Devkit para `lib/`. O app lista exatamente quais ao abrir.

## Pré-requisitos

- Node.js 22+ (usa `node:sqlite` nativo)
- Java 11+
- Os jars do Delphix acima, em `lib/`

## Iniciar

```bash
# Instalar dependências (root + frontend)
npm install
npm install --prefix frontend

# Desenvolvimento: Express (porta 3000) + Vite (porta 5173) em paralelo
npm run dev
# Acesse: http://localhost:5173

# Produção: compila o frontend e sobe o Express
npm start
# Acesse: http://localhost:3000

# Só compilar o frontend
npm run build
```

## Assistente de IA

A tela inicial tem um chat que ajuda de duas formas: explicando como um framework funciona e qual
se encaixa em cada situação, e **construindo um algoritmo pronto para uso** a partir de um
problema descrito em linguagem natural. Você não precisa saber qual framework usar — é isso que
ele resolve.

Por exemplo:

> Preciso criar um algoritmo para mascarar um campo numérico em coluna char, ou seja, completa
> com zeros à esquerda. O tamanho da coluna é 15 caracteres, e preciso que gere um número
> aleatório mantendo a mesma quantidade de zeros à esquerda do valor original.

O assistente escolhe o Character Mapping com `preserveLeadingZeros`, configura e salva em
**Algoritmos** na barra lateral, pronto para executar.

Antes de salvar, o servidor **executa o algoritmo de verdade** com a configuração que o modelo
produziu. Se o runner recusar — parâmetro inventado, combinação inválida — nada é salvo e o erro
aparece no chat. Uma configuração alucinada nunca vira um algoritmo salvo.

O assistente conhece os 31 frameworks: o system prompt é montado com as mesmas descrições que a
UI mostra, mais o JSON Schema real de cada framework lido do plugin.

### Como configurar

Vá em **Configurações → IA**, escolha o provedor e preencha os campos. O card de status embaixo
mostra se o provedor está acessível.

| Provedor | Endpoint | Credencial | Modelo de exemplo |
|---|---|---|---|
| **Ollama (local)** — padrão | `http://localhost:11434` | nenhuma | `llama3.1` |
| Claude / Anthropic | — (SDK oficial) | chave de API do [console.anthropic.com](https://console.anthropic.com) | `claude-opus-5` |
| Google Gemini | `https://generativelanguage.googleapis.com` | chave de API do Google AI Studio | `gemini-2.5-pro` |
| GitHub Models (Copilot) | `https://models.github.ai/inference` | token do GitHub com escopo `models:read` | `gpt-4o` |

O padrão é o Ollama, que roda inteiramente na sua máquina — nada sai dela. Para usar:

```bash
brew install ollama     # ou baixe em ollama.com
ollama serve
ollama pull llama3.1
```

As chaves de API ficam em `db/algorithms.db` e nunca voltam para o navegador: depois de salva, o campo
mostra uma máscara e você troca a chave digitando uma nova.

"GitHub Models (Copilot)" é o endpoint compatível com OpenAI que vem com a conta do GitHub. O
GitHub Copilot em si não expõe API de chat para aplicações de terceiros.

> **Sobre modelos locais.** O catálogo de frameworks ocupa cerca de 12k tokens de contexto. É
> folgado para Claude e Gemini, mas apertado para modelos locais pequenos — um com janela de 8k
> vai truncar o catálogo e errar a escolha do framework. Prefira um modelo com contexto grande.

## Achar as coisas na barra lateral

Dois filtros, e eles estreitam juntos. A **caixa de texto** alcança todas as sessões de uma vez —
um nome é achado sem precisar saber em qual delas ele mora — e os resultados saem em lista plana,
para que um acerto nunca fique escondido atrás de um cabeçalho que você teria de abrir antes. A
**caixa de profile set** deixa só o que um set alcança, seguido para fora do jeito que a
sincronização segue: os classifiers dele, os domínios em que eles votam, os algoritmos desses
domínios e os frameworks por trás deles. Escolher um set transforma a barra inteira no conjunto de
trabalho de uma regra de conformidade.

O `⋯` de cada sessão também escolhe como ela organiza os itens, e a escolha é lembrada:

| Sessão | Agrupar por |
|---|---|
| Frameworks | categoria, ou nada |
| Algoritmos | categoria do framework, domínio, profile set, ou nada |
| Domínios | categoria do framework, profile set, ou nada |
| Classifiers | domínio, framework do algoritmo do domínio, framework do classifier, profile set, ou nada |

Agrupar é uma visão, não uma classificação. Um item pode aparecer sob mais de um cabeçalho — um
classifier pertence a todo profile set que o roda — e o que não cai em nenhum fica em **Outros**,
que é uma resposta de verdade, não um erro.

## Sincronizar com um Masking Engine

**Uma instância, espelhada.** Conectar uma instância em *Configurações → Delphix* traz o engine
inteiro de uma vez — todos os profile sets, classifiers, domínios e algoritmos — e os campos da
conexão então travam. Não há nada de útil em editar uma URL debaixo de um espelho da instância que
aquela URL não nomeia mais, então trocar de engine é excluir a integração e configurar a outra.

Três botões mantêm o espelho em dia:

- **Atualizar do Delphix** traz tudo de novo, atualizando o que já está aqui.
- **Enviar tudo para o Delphix** empurra no sentido contrário, em ordem de dependência —
  algoritmos, depois os domínios que os nomeiam, depois os classifiers que votam neles, depois os
  sets que rodam os classifiers. Cada objeto continua com o seu **Enviar ao Delphix** no editor.
- **Excluir integração** esquece a conexão e apaga toda linha vinculada àquele engine.
  "Vinculada" inclui o que você criou aqui e enviou para lá, e o diálogo diz isso com todas as
  letras: `delphix_origin` é o único registro da ligação, e os dois sentidos o gravam. Os arquivos
  já baixados continuam na pasta de arquivos.

As instâncias de plugin da própria instância (`dlpx-core:`) não descem. Esta ferramenta tem o mesmo
plugin, então uma cópia salva de uma delas seria uma linha que não responde por nada.

Aponte a ferramenta para uma instância Delphix em **Configurações → Delphix** — endereço, usuário
e senha — e clique em **Testar conexão**; ele responde antes de você salvar qualquer coisa.

### Domínios

A sessão **Domínios** da barra lateral guarda os domínios de dado sensível — na instância um
domínio é um nome e duas referências a algoritmo, e é exatamente isso que fica guardado aqui. Crie
um em *Domínios → ⋯ → Novo domínio*; cada um
tem o botão **Enviar ao Delphix**, que cria lá, ou atualiza quando o nome já existe.

Enviar um domínio **envia antes os algoritmos para os quais ele aponta** — a instância recusa um
domínio cujo algoritmo ela não conhece. Algoritmos que já são da instância, como os built-in
`dlpx-core:`, não são tocados: lá eles são somente leitura e já estão certos. Se um algoritmo não
puder ser enviado, o domínio também não vai, e a mensagem diz qual algoritmo falhou.

Os domínios são agrupados pelo framework do algoritmo para o qual apontam, nas mesmas categorias
do resto. Entre um domínio e sua categoria há duas buscas, e qualquer uma pode falhar — o
algoritmo pode ser um built-in que esta máquina não tem, e nem todo algoritmo de uma instância é
baseado em framework. Esses caem em **Outros**, que numa instância padrão é cerca de um quinto.

### Classifiers

Classifiers são o que o profiling usa para decidir a que domínio uma coluna ou campo pertence.
Cada um é construído sobre um de quatro frameworks — **PATH** (o nome do campo e da sua tabela ou
arquivo), **TYPE** (o tipo e o tamanho), **REGEX** e **LIST** (uma amostra dos valores) — e vota em
um domínio. A sessão **Classifiers** da barra lateral os lista por domínio; crie um em
*Classifiers → ⋯ → Novo classifier*.

O editor explica cada parâmetro do framework escolhido, e o painel **Teste** descreve um campo —
nome, tabela, tipo SQL, tamanho, valores de amostra — e mostra o que o profiling concluiria: a
confiança deste classifier (qual caminho, tipo, padrão ou lista decidiu, valor a valor) e a do
domínio, pesado junto com os outros classifiers salvos para ele, contra o limiar do profile set. Ele
testa o que está na tela, então dá para experimentar uma mudança antes de salvar. Nada roda na
instância: a ferramenta avalia os classifiers localmente, lendo as expressões regulares como o Java
lê. As poucas construções Java que ela não reproduz com exatidão são avisadas em vez de aproximadas.

**Enviar ao Delphix** cria o classifier na instância ou o atualiza; renomear não é problema, porque
a instância renomeia classifiers no lugar. O que um classifier usa vai junto: a instância recusa um
classifier cujo domínio ela não tem, então o domínio vai antes quando esta máquina o tem — junto
com os algoritmos dele — e os arquivos de valores de um classifier LIST são enviados quando a
instância não os tem. Importar faz o mesmo no sentido inverso: o classifier vem com o domínio, os
algoritmos desse domínio e os arquivos de valores.

### Profile sets

Um profile set é o que um job de profiling de fato roda: os classifiers que ele deve tentar e o
**limiar de atribuição** — a confiança que um domínio precisa alcançar para o job atribuí-lo. A
sessão **Profile Sets** da barra lateral os lista com o tamanho e o limiar; crie um em *Profile
Sets → ⋯ → Novo profile set*.

O editor escolhe os membros entre os classifiers guardados aqui, filtrando por nome ou domínio. Não
há o que testar num set: quem decide o domínio são os classifiers, e eles são configurados e
testados no editor deles.

Tudo em que um set se apoia viaja junto com ele. Importar um traz os classifiers que ele nomeia e,
através deles, os domínios, os algoritmos desses domínios e os arquivos de valores. **Enviar ao
Delphix** faz o inverso: cada membro vai primeiro, e o set é então criado ou atualizado nomeando-os
pelos ids que a instância devolveu — um set só pode referenciar classifiers que a instância já tem.

**Importar.** Não há importação por objeto: conectar a integração traz o engine inteiro, e
**Atualizar do Delphix** traz de novo. Um algoritmo sobre um framework que a ferramenta não
consegue executar não é copiado — assim você nunca fica com um algoritmo salvo que não dá para
testar — e aparece no resumo do que ficou de fora. O que um objeto referencia vem junto: os
algoritmos que uma configuração nomeia, o arquivo de lookup, os algoritmos de um domínio, os
classifiers de um set.

**Arquivos de lookup.** Um arquivo enviado para a instância fica no armazenamento dela: o
algoritmo carrega só uma referência (`delphix-file://upload/…/NOMES.txt`). Importar baixa o arquivo
para **Arquivos** sempre que a instância permite — o arquivo de lookup de um Secure Lookup e os
arquivos de valores de um classifier LIST. Para outros frameworks a instância não oferece download:
a janela de importação diz quais são esses arquivos, e o algoritmo é importado do mesmo jeito —
adicione uma cópia em **Arquivos**, mantendo o nome do arquivo da instância, e ele roda sem
nenhuma alteração.

Qualquer lista com o formato certo já serve para ver o algoritmo funcionando. Para reproduzir o que
a instância produz, o arquivo precisa bater linha a linha: um algoritmo que escolhe o substituto
pelo hash da entrada seleciona por posição, então lista diferente é resultado diferente.

**Exportar.** Cada algoritmo salvo tem o botão **Enviar ao Delphix**. O que veio da instância é
atualizado lá; o que você construiu aqui é criado. A ferramenta lembra de onde cada algoritmo veio,
então exportar duas vezes nunca deixa uma duplicata. Os algoritmos que ele referencia vão antes, e
qualquer arquivo que a instância não conseguiria abrir — um caminho desta máquina, ou um arquivo da
instância que ela já não guarda para um algoritmo novo — é enviado a partir de **Arquivos**, com a
configuração apontando para ele. Um arquivo que falta nesta máquina interrompe o envio, e a
mensagem diz qual.

**Ida e volta.** Testar um algoritmo importado com um arquivo local não muda o que volta para a
instância: a referência fica guardada como a instância escreveu, e a cópia local só é resolvida na
hora de executar aqui. Ajuste qualquer parâmetro, mande de volta, e a instância continua lendo o
arquivo dela. O único jeito de quebrar isso é escolher outro arquivo no formulário de configuração
— isso substitui a referência. O formulário mostra um arquivo da instância como *nome (na
instância)*, para que nunca seja confundido com campo vazio; um caminho desta máquina escolhido ali
é enviado junto quando o algoritmo vai para a instância.

**Nomes.** Na instância o nome do algoritmo é a identidade dele e não pode ser alterado, então a
ferramenta segue a mesma regra: nomes não são editáveis. Para trabalhar com outro nome, use
**Duplicar** e dê o nome à cópia — a cópia não fica vinculada, então enviá-la cria um algoritmo novo.

Se o plugin de mascaramento da instância for mais antigo que o de `lib/`, alguns frameworks não
existirão lá; exportar um algoritmo desses falha com uma mensagem explicando.

Se preferir não guardar a senha em disco, defina `DLPX_ENGINE_PASSWORD` no ambiente — ela tem
precedência e o campo passa a aparecer somente leitura.

## Idioma da interface

A UI está disponível em inglês, português (BR) e espanhol. Por padrão segue o idioma do
navegador; para fixar um, clique numa bandeira no rodapé da barra lateral. Vale na hora. Depois de
fixar um idioma aparece um link **auto** ao lado das bandeiras, que volta a seguir o navegador. A
escolha é guardada no servidor, então vale para qualquer navegador que abrir a aplicação.

## AlgorithmRunner

O `AlgorithmRunner.java` é um processo Java de vida curta (fork por requisição) que:

1. Recebe JSON via stdin com `command`, `framework`, `config`, `input`, `key`
2. Instancia a classe do framework via reflection
3. Aplica a configuração via `ComponentConfigurator.applyConfiguration`
4. Constrói um `ComponentService` mínimo com `CryptoService` baseado na chave
5. Chama `setup()` recursivamente, depois `validate()`, depois `mask(input)`
6. Retorna o resultado como JSON via stdout


## Compilar o AlgorithmRunner

Se modificar o `AlgorithmRunner.java`:

```bash
cd java-runner
javac --release 11 -cp "$(ls ../lib/*.jar | tr '\n' ':')" AlgorithmRunner.java
jar cfe AlgorithmRunner.jar AlgorithmRunner *.class
```

O `--release 11` importa: o jar é commitado e nada o recompila na máquina de quem instala, então
este bytecode é o que todo usuário executa. Sem a flag, o `javac` mira a JDK que você tiver, e
quem estiver num Java mais antigo bate em `UnsupportedClassVersionError` já na primeira operação
de mascaramento. Java 11 é o piso que os pré-requisitos e os instaladores prometem.

## Licença

[Mozilla Public License 2.0](LICENSE). Modificações nos arquivos deste projeto continuam abertas;
você pode combiná-lo com código sob outras licenças. Os jars do Delphix carregados em runtime não
são cobertos por esta licença e não são distribuídos aqui.

**Marcas e vínculo.** Delphix, Delphix Continuous Compliance e os demais nomes de produto citados
aqui são marcas de seus respectivos donos. Este projeto é independente: não tem vínculo com eles,
não é endossado nem suportado por eles, e usá-lo não concede qualquer direito sobre o software da
Delphix que ele carrega.
