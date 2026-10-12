{{NAME}} — version {{VERSION}}
============================================================

ENGLISH

This package loads a discovery policy into Delphix — Data Control Tower (DCT) or a Continuous
Compliance Engine, whichever you choose — with everything it relies on: its classifiers, their
data classes, the algorithms of those data classes and the files they read.

  docs/      the documentation, in English, Portuguese and Spanish
  data/      every object, ready for the DCT API and for an engine's Masking API, and the files
  import.sh  for Linux and macOS — needs bash, curl and jq
  import.ps1 for Windows — Windows PowerShell 5.1 (built into Windows 10 and 11) or PowerShell 7

Run it from this folder:

  Linux / macOS:   ./import.sh
  Windows:         powershell -ExecutionPolicy Bypass -File .\import.ps1

The script asks, in order: the language of its messages; DCT or engine; the address and the
credentials (a DCT API key, or an engine user and password); whether to accept a self-signed
certificate; and the pack — essential (the minimum for the law) or extended (everything).

Before changing anything it lists the objects that already exist there under the same names, and
asks for confirmation: those are DELETED before the import. Whatever Delphix refuses to delete,
because something else uses it, is updated instead. Every step is written to import-<date>.log
next to the script; passwords and keys never are.

In DCT only the objects DCT itself manages are touched; DCT's built-in objects are referenced and
never changed. On a Continuous Compliance Engine used on its own, data classes are called domains
and the discovery policy is a profile set.


PORTUGUÊS

Este pacote carrega uma política de descoberta no Delphix — o Data Control Tower (DCT) ou um
Continuous Compliance Engine, o que você escolher — com tudo de que ela precisa: os classifiers, as
classes de dados deles, os algoritmos dessas classes e os arquivos que eles leem.

  docs/      a documentação, em inglês, português e espanhol
  data/      cada objeto, pronto para a API do DCT e para a Masking API de um engine, e os arquivos
  import.sh  para Linux e macOS — precisa de bash, curl e jq
  import.ps1 para Windows — Windows PowerShell 5.1 (já vem no Windows 10 e 11) ou PowerShell 7

Rode a partir desta pasta:

  Linux / macOS:   ./import.sh
  Windows:         powershell -ExecutionPolicy Bypass -File .\import.ps1

O script pergunta, nesta ordem: o idioma das mensagens; DCT ou engine; o endereço e as
credenciais (uma chave de API do DCT, ou usuário e senha do engine); se aceita certificado
autoassinado; e o pacote — essencial (o mínimo para a lei) ou estendido (tudo).

Antes de alterar qualquer coisa ele lista os objetos que já existem lá com os mesmos nomes e pede
confirmação: esses objetos são APAGADOS antes da importação. O que o Delphix se recusar a apagar,
porque algo mais o usa, é atualizado em vez disso. Cada passo vai para import-<data>.log ao lado do
script; senhas e chaves, nunca.

No DCT só são tocados os objetos que o próprio DCT gerencia; os objetos de fábrica do DCT são
referenciados e nunca alterados. Num Continuous Compliance Engine usado sozinho, as classes de
dados se chamam domínios e a política de descoberta é um profile set.


ESPAÑOL

Este paquete carga una política de descubrimiento en Delphix — Data Control Tower (DCT) o un
Continuous Compliance Engine, lo que elijas — con todo lo que necesita: sus classifiers, las clases
de datos de estos, los algoritmos de esas clases y los archivos que leen.

  docs/      la documentación, en inglés, portugués y español
  data/      cada objeto, listo para la API de DCT y para la Masking API de un engine, y los archivos
  import.sh  para Linux y macOS — necesita bash, curl y jq
  import.ps1 para Windows — Windows PowerShell 5.1 (viene con Windows 10 y 11) o PowerShell 7

Ejecútalo desde esta carpeta:

  Linux / macOS:   ./import.sh
  Windows:         powershell -ExecutionPolicy Bypass -File .\import.ps1

El script pregunta, en este orden: el idioma de los mensajes; DCT o engine; la dirección y las
credenciales (una clave de API de DCT, o usuario y contraseña del engine); si acepta un certificado
autofirmado; y el paquete — esencial (lo mínimo para la ley) o extendido (todo).

Antes de cambiar nada lista los objetos que ya existen allí con los mismos nombres y pide
confirmación: esos objetos se BORRAN antes de la importación. Lo que Delphix se niegue a borrar,
porque algo más lo usa, se actualiza en su lugar. Cada paso queda en import-<fecha>.log junto al
script; contraseñas y claves, nunca.

En DCT solo se tocan los objetos que administra el propio DCT; los objetos de fábrica de DCT se
referencian y nunca se modifican. En un Continuous Compliance Engine usado por sí solo, las clases
de datos se llaman dominios y la política de descubrimiento es un profile set.
