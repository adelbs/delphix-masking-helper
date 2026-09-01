# Delphix Masking Helper

[English](README.md) · **Português (BR)** · [Español](README.es.md)

Um companheiro local para o plugin de mascaramento do Delphix. Ajuda a **entender** como cada
framework de mascaramento se comporta, **testar** um algoritmo contra valores reais e **construir**
um algoritmo já configurado a partir de um problema descrito em linguagem natural — tudo sem
precisar criar um Rule Set ou executar um Job em um Masking Engine.

> **Você precisa do SDK da Delphix para rodar isto.** Os algoritmos de mascaramento vivem em jars
> licenciados do produto Delphix, que **não** são distribuídos aqui. Solicite o Masking Devkit
> (SDK) à Delphix e coloque quinze jars em `lib/` — veja [Bibliotecas do Delphix](#bibliotecas-do-delphix)
> abaixo. Referência: [Compliance Algorithm SDK](https://portal.perforce.com/s/article/Compliance-Algorithm-SDK-for-Guidewire-1728062704114).

![O assistente criando um algoritmo e o algoritmo sendo testado](docs/demo.gif)

<sub>Gravado com o provedor local padrão (Ollama · `llama3.1:8b`) num M1 Pro. A resposta do
modelo está acelerada — localmente leva cerca de um minuto. Todos os valores mascarados são
saída real do plugin.</sub>

## Como funciona

O servidor Node expõe uma API REST que delega cada operação para o `AlgorithmRunner.jar`, que carrega e executa os algoritmos via reflection. O frontend React é servido pelo Vite em desenvolvimento (com hot-reload) e pelo Express em produção.

## Guia dos algoritmos

Cada algoritmo abre com duas abas: **Testar** e **Documentação**. A aba de documentação mostra a
seção daquele algoritmo no guia de referência, no idioma da interface — o mesmo conteúdo dos PDFs
abaixo, lido da mesma fonte, então os dois nunca divergem.

O diretório [`docs/`](docs/) contém um guia de referência dos 31 algoritmos do plugin, em três idiomas:

| Idioma | Arquivo |
|---|---|
| Português (BR) | [`docs/delphix-algorithms-guide.pt-BR.pdf`](docs/delphix-algorithms-guide.pt-BR.pdf) |
| English | [`docs/delphix-algorithms-guide.en.pdf`](docs/delphix-algorithms-guide.en.pdf) |
| Español | [`docs/delphix-algorithms-guide.es.pdf`](docs/delphix-algorithms-guide.es.pdf) |

Para cada algoritmo o guia traz o que ele faz, exemplos de entrada → saída, e a explicação de todos os parâmetros de configuração. Os algoritmos são agrupados pelas mesmas categorias da barra lateral da UI. Há ainda três apêndices: conceitos transversais (determinismo, papel da chave, algoritmos que podem não mascarar nada), o catálogo das 62 instâncias `dlpx-core:` embutidas no plugin, e as limitações do runner standalone.

Todos os pares entrada → saída foram gerados executando os algoritmos no `AlgorithmRunner` — não são ilustrativos.

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

A tela inicial tem um chat que ajuda de duas formas: explicando como um algoritmo funciona e qual
se encaixa em cada situação, e **construindo um algoritmo pronto para uso** a partir de um
problema descrito em linguagem natural. Você não precisa saber qual framework usar — é isso que
ele resolve.

Por exemplo:

> Preciso criar um algoritmo para mascarar um campo numérico em coluna char, ou seja, completa
> com zeros à esquerda. O tamanho da coluna é 15 caracteres, e preciso que gere um número
> aleatório mantendo a mesma quantidade de zeros à esquerda do valor original.

O assistente escolhe o Character Mapping com `preserveLeadingZeros`, configura e salva em
**Testes/Algoritmos Salvos**, pronto para executar.

Antes de salvar, o servidor **executa o algoritmo de verdade** com a configuração que o modelo
produziu. Se o runner recusar — parâmetro inventado, combinação inválida — nada é salvo e o erro
aparece no chat. Uma configuração alucinada nunca vira um teste salvo.

O assistente conhece os 31 algoritmos: o system prompt é montado com as mesmas descrições que a
UI mostra, mais o JSON Schema real de cada algoritmo lido do plugin.

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

As chaves de API ficam em `db/tests.db` e nunca voltam para o navegador: depois de salva, o campo
mostra uma máscara e você troca a chave digitando uma nova.

"GitHub Models (Copilot)" é o endpoint compatível com OpenAI que vem com a conta do GitHub. O
GitHub Copilot em si não expõe API de chat para aplicações de terceiros.

> **Sobre modelos locais.** O catálogo de algoritmos ocupa cerca de 12k tokens de contexto. É
> folgado para Claude e Gemini, mas apertado para modelos locais pequenos — um com janela de 8k
> vai truncar o catálogo e errar a escolha do algoritmo. Prefira um modelo com contexto grande.

## Idioma da interface

A UI está disponível em inglês, português (BR) e espanhol. Por padrão segue o idioma do
navegador; para fixar um, clique numa bandeira no rodapé da barra lateral. Vale na hora. Depois de
fixar um idioma aparece um link **auto** ao lado das bandeiras, que volta a seguir o navegador. A
escolha é guardada no servidor, então vale para qualquer navegador que abrir a aplicação.

## AlgorithmRunner

O `AlgorithmRunner.java` é um processo Java de vida curta (fork por requisição) que:

1. Recebe JSON via stdin com `command`, `algorithm`, `config`, `input`, `key`
2. Instancia a classe do algoritmo via reflection
3. Aplica a configuração via `ComponentConfigurator.applyConfiguration`
4. Constrói um `ComponentService` mínimo com `CryptoService` baseado na chave
5. Chama `setup()` recursivamente, depois `validate()`, depois `mask(input)`
6. Retorna o resultado como JSON via stdout


## Compilar o AlgorithmRunner

Se modificar o `AlgorithmRunner.java`:

```bash
cd java-runner
javac -cp "$(ls ../lib/*.jar | tr '\n' ':')" AlgorithmRunner.java
jar cfe AlgorithmRunner.jar AlgorithmRunner *.class
```

## Licença

[Mozilla Public License 2.0](LICENSE). Modificações nos arquivos deste projeto continuam abertas;
você pode combiná-lo com código sob outras licenças. Os jars do Delphix carregados em runtime não
são cobertos por esta licença e não são distribuídos aqui.
