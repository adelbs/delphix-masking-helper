# Delphix Masking Helper

[English](README.md) · [Português (BR)](README.pt-BR.md) · **Español**

🌐 **[Sitio web](https://adelbs.github.io/delphix-masking-helper/index.es.html)** — qué hace la herramienta, y la referencia completa de los frameworks, en tres idiomas.

Un compañero local para el plugin de enmascaramiento de Delphix, que cubre la vida entera de un
algoritmo. Ayuda a **entender** cómo se comporta cada uno de los 31 frameworks de enmascaramiento,
**probar** un algoritmo con valores reales, **construir** un algoritmo ya configurado a partir de
un problema descrito en lenguaje natural y **sincronizar** con Delphix — **Data Control Tower** o un
**Continuous Compliance Engine**, uno u otro — trayendo sus algoritmos para trabajar y devolviendo
los tuyos. Todo sin crear un Rule Set ni ejecutar un
masking job.

Cubre también el descubrimiento de dato sensible: las **clases de datos** a las que puede pertenecer
una columna, los **classifiers** que lo deciden — cada uno se puede probar con una columna que
describes — y las **políticas de descubrimiento** que ejecuta un job de descubrimiento. Con la herramienta vienen
políticas de descubrimiento listas para las leyes de protección de datos de **Chile, México, Panamá, Belice, Brasil, Colombia, Argentina, El Salvador, Perú, Ecuador, Uruguay, Costa Rica, España y Jamaica**,
cada una se carga con un clic y está documentada en PDF.

> **La nomenclatura sigue la de Delphix, y la de Data Control Tower.** Un **framework** es una
> técnica de enmascaramiento que ofrece el plugin — Secure Lookup, Character Mapping, Date Shift.
> Configurar uno produce un **algoritmo**: con nombre, guardado y listo para usar. La barra lateral
> lista frameworks; lo que guardas es un algoritmo. En el descubrimiento los nombres son los de DCT:
> **clase de datos** (*data class*) y **política de descubrimiento** (*discovery policy*) — un
> Continuous Compliance Engine usado por sí solo llama a los mismos objetos dominio y profile set.

> ### Proyecto independiente, y requiere licencia Delphix activa
>
> **Sin ninguna relación con Delphix.** Este es un proyecto open source independiente. No está
> hecho, respaldado, revisado ni soportado por Delphix ni por sus titulares, y nada aquí es un
> producto oficial. Delphix y los nombres de producto usados aquí son marcas de sus respectivos
> dueños.
>
> **Se requiere una licencia Delphix activa.** Los frameworks de enmascaramiento viven en jars
> licenciados del producto Delphix, que **no** se distribuyen aquí — este proyecto ni los entrega
> ni los sustituye. Ya debes tener derecho a ellos y poder obtener el Masking Devkit (SDK) de
> Delphix, normalmente mediante una licencia activa y tu equipo de cuenta. Coloca quince jars en
> `lib/` — consulta [Bibliotecas de Delphix](#bibliotecas-de-delphix) más abajo. Referencia: [Compliance Algorithm SDK](https://portal.perforce.com/s/article/Compliance-Algorithm-SDK-for-Guidewire-1728062704114).

![Un algoritmo siendo probado, un classifier probado con una columna descrita, las políticas de descubrimiento que vienen con la herramienta, y una instancia Delphix conectada](docs/demo.gif)

<sub>Cuatro cosas, en este orden: ejecutar un algoritmo con un valor real; probar un classifier con
una columna descrita en pantalla y ver qué clase de datos asignaría el descubrimiento; las políticas de descubrimiento que
vienen con la herramienta; y la integración con una instancia Delphix, con un algoritmo que vino
de ella. Todos los valores enmascarados son salida real del plugin, cada puntuación sale del
evaluador local de classifiers, y la instancia es real.</sub>

## Cómo funciona

El servidor Node expone una API REST que delega cada operación en `AlgorithmRunner.jar`, que carga y ejecuta los frameworks mediante reflection. El frontend React lo sirve Vite en desarrollo (con hot-reload) y Express en producción.

## Guía de los frameworks

📖 **[Leer la referencia de los frameworks en línea](https://adelbs.github.io/delphix-masking-helper/frameworks.es.html)** — el mismo contenido de los PDF, en tres idiomas.

Cada framework abre con dos pestañas: **Probar** y **Documentación**. La pestaña de documentación
muestra la sección de ese framework en la guía de referencia, en el idioma de la interfaz — el
mismo contenido de los PDF de abajo, leído de la misma fuente, así que nunca divergen.

La pantalla de classifiers tiene la misma pestaña **Documentación**: abre con cómo el descubrimiento
decide una clase de datos, seguida de la sección del framework de classifier en cuestión.

El directorio [`docs/`](docs/) contiene una guía de referencia de los 31 frameworks del plugin, en tres idiomas:

| Idioma | Archivo |
|---|---|
| Español | [`docs/delphix-frameworks-guide.es.pdf`](docs/delphix-frameworks-guide.es.pdf) |
| English | [`docs/delphix-frameworks-guide.en.pdf`](docs/delphix-frameworks-guide.en.pdf) |
| Português (BR) | [`docs/delphix-frameworks-guide.pt-BR.pdf`](docs/delphix-frameworks-guide.pt-BR.pdf) |

Para cada framework la guía explica qué hace, ejemplos de entrada → salida y la descripción de todos los parámetros de configuración. Los frameworks se agrupan según las mismas categorías de la barra lateral de la UI. La Parte 10 trata el descubrimiento de dato sensible: cómo se decide una clase de datos, y los frameworks de classifier `PATH`, `TYPE`, `REGEX` y `LIST`. Incluye además tres apéndices: conceptos transversales (determinismo, papel de la clave, frameworks que pueden no enmascarar nada), el catálogo de los 59 algoritmos `dlpx-core:` incorporadas en el plugin y las limitaciones del runner standalone.

Todos los pares entrada → salida se generaron ejecutando los frameworks en `AlgorithmRunner` — no son ilustrativos.

### Regenerar los PDFs

Las fuentes están en `docs/src/` (un HTML por idioma + `guide.css` compartido). Después de editar, recompila:

```bash
./docs/build.sh            # todos los idiomas
./docs/build.sh pt-BR es   # solo los idiomas indicados
```

El build usa Chrome headless y fuentes instaladas en macOS (Iowan Old Style, Seravek, Menlo), así que los PDFs deben regenerarse en un Mac para conservar la tipografía.

## Bibliotecas de Delphix

El tester ejecuta los frameworks reales del plugin de enmascaramiento de Delphix, así que
necesita algunos jars del producto. **No se distribuyen en este repositorio** — son archivos
licenciados de Delphix. Los aportas tú, una sola vez.

1. Solicita a Delphix el **Masking Devkit (SDK)** correspondiente a tu versión del Masking
   Engine, a través de tu equipo de cuenta o del portal de soporte. Delphix documenta el SDK
   aquí: [Compliance Algorithm SDK](https://portal.perforce.com/s/article/Compliance-Algorithm-SDK-for-Guidewire-1728062704114).
2. Descomprímelo y copia estos quince jars de `sdkTools/lib/` a [`lib/`](lib/):

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

Las versiones no tienen que ser concretas — el servidor busca por prefijo del nombre de archivo,
así que sirve lo que venga en tu SDK. El resto de `sdkTools/lib/` pertenece al CLI del propio SDK
y no hace falta; copiarlo todo también funciona, solo infla el classpath.

Si falta algún jar, el servidor lo avisa al arrancar indicando qué no encontró, y la UI muestra
el mismo mensaje en lugar de fallar en silencio. Para apuntar a un plugin fuera de `lib/`, define
`DLPX_PLUGIN_JAR` con su ruta completa.

Consulta [`lib/README.md`](lib/README.md) para saber para qué sirve cada jar.

## Instalación

**macOS / Linux**

```bash
curl -fsSL https://adelbs.github.io/delphix-masking-helper/install.sh | bash
```

**Windows** — en PowerShell, no en el Símbolo del sistema: `irm` es un comando de PowerShell, y
`cmd.exe` responde `'irm' is not recognized`.

```powershell
irm https://adelbs.github.io/delphix-masking-helper/install.ps1 | iex
```

Si falla con `Could not create SSL/TLS secure channel`, PowerShell está negociando TLS 1.0, que
GitHub ya no acepta — Windows antiguos, Server 2016 entre ellos. Ejecuta esto primero, en la
misma ventana, y luego la línea de arriba:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
```

¿Prefieres leerlo antes de ejecutarlo? Es lo mismo en dos pasos:

```bash
curl -fsSL https://adelbs.github.io/delphix-masking-helper/install.sh -o install.sh
less install.sh && bash install.sh
```

El script pregunta dónde instalar, comprueba que Node, Java y git estén presentes — nunca los
instala, solo avisa de lo que falta —, clona la release más nueva, la compila y deja el comando
`dlpx-helper` en tu PATH.

| | |
|---|---|
| `dlpx-helper` | arranca y abre el navegador |
| `dlpx-helper stop` | lo detiene |
| `dlpx-helper status` | ¿está funcionando? |
| `dlpx-helper version` | qué versión está instalada |
| `dlpx-helper logs` | sigue el log |
| `dlpx-helper update` | pasa a la release más nueva y recompila |
| `dlpx-helper uninstall` | lo elimina (pregunta antes) |

### ¿En qué versión estoy?

Tres lugares lo dicen, y ninguno toca la red:

- el **pie de la barra lateral**, debajo de las banderas de idioma;
- **Configuración → General → Acerca de**, con el commit y el comando de actualización;
- `dlpx-helper version` en la terminal, más la línea que el servidor imprime al arrancar.

El número viene de la etiqueta git del checkout, así que es la release que realmente tienes —
`v1.0.3` en una release, `v1.0.3-5-gabc1234` cuando el código va por delante de la última
etiqueta, y con `-dirty` al final cuando hay cambios sin confirmar. Sin git, recurre a la versión
declarada en `package.json`, que puede estar atrasada.

**No hay comprobación de actualizaciones.** La herramienta dice lo que tienes, nunca lo que existe
en otro sitio; `dlpx-helper update` es como te enteras — ejecutándolo. Eso mantiene la misma
promesa que el modelo local por defecto: nada sale de tu máquina sin que lo pidas.

**La instalación queda fijada a una release, no a la punta de `main`.** El script le pregunta al
remoto cuál es la etiqueta `vX.Y.Z` más nueva y hace checkout de ella, así que un commit enviado
después de la última release nunca te llega; las etiquetas de prelanzamiento como `v2.0.0-rc1`
también se omiten. Para sobrescribirlo usa `DLPX_REF` — `DLPX_REF=v1.0.0` fija una release
anterior, y un nombre de rama hace que siga esa rama. Si el repositorio no tiene ninguna etiqueta
de release, el script recurre a la rama por defecto y lo avisa.

Volver a ejecutar el script en una máquina que ya lo tiene ofrece **actualizar** o **eliminar**.
Actualizar nunca toca `db/`, donde viven tus algoritmos guardados y tu configuración. Desinstalar
borra todo, por eso avisa antes — copia la carpeta `db/` a otro sitio si quieres conservar lo que
hay en ella.

### O hazlo a mano

El script no hace nada que no puedas hacer tú:

```bash
git clone https://github.com/adelbs/delphix-masking-helper.git
cd delphix-masking-helper
npm install && npm install --prefix frontend
npm run build
npm start          # http://localhost:3000
```

De cualquier forma, el último paso es el mismo y solo tú puedes darlo: copiar los jars de tu
Masking Devkit a `lib/`. La app lista exactamente cuáles al abrirla.

## Requisitos

- Node.js 22+ (usa `node:sqlite` nativo)
- Java 11+
- Los jars de Delphix anteriores, en `lib/`

## Iniciar

```bash
# Instalar dependencias (root + frontend)
npm install
npm install --prefix frontend

# Desarrollo: Express (puerto 3000) + Vite (puerto 5173) en paralelo
npm run dev
# Abre: http://localhost:5173

# Producción: compila el frontend y levanta Express
npm start
# Abre: http://localhost:3000

# Solo compilar el frontend
npm run build
```

## Asistente de IA

La pantalla de inicio tiene un chat que ayuda de dos formas: explicando cómo funciona un algoritmo
y cuál encaja en cada situación, y **construyendo un algoritmo listo para usar** a partir de un
problema descrito en lenguaje natural. No necesitas saber qué framework usar — de eso se encarga
él. Construir requiere un proveedor alojado — Claude, Gemini, OpenAI o GitHub Models; un modelo local solo
aconseja (consulta [Un modelo local aconseja](#un-modelo-local-aconseja)).

Por ejemplo:

> Necesito enmascarar un campo numérico en una columna CHAR rellenada con ceros a la izquierda.
> La columna tiene 15 caracteres y necesito un número aleatorio que conserve la misma cantidad de
> ceros a la izquierda que el valor original.

El asistente elige Character Mapping con `preserveLeadingZeros`, lo configura y lo guarda en
**Algoritmos** en la barra lateral, listo para ejecutar.

Antes de guardar, el servidor **ejecuta el algoritmo de verdad** con la configuración que produjo
el modelo. Si el runner la rechaza — un parámetro inventado, una combinación inválida — no se
guarda nada y el error aparece en el chat. Una configuración alucinada nunca se convierte en un
algoritmo guardado.

El asistente conoce los 31 frameworks: su system prompt se construye con las mismas descripciones
que muestra la UI, más el JSON Schema real de cada framework leído del plugin.

### Cómo configurarlo

Ve a **Configuración → IA**, elige el proveedor y rellena los campos. La tarjeta de estado de
abajo indica si el proveedor está accesible.

| Proveedor | Endpoint | Credencial | Modelo de ejemplo |
|---|---|---|---|
| **Ollama (local)** — por defecto | `http://localhost:11434` | ninguna | `llama3.1` |
| Claude / Anthropic | — (SDK oficial) | clave de API de [console.anthropic.com](https://console.anthropic.com) | `claude-opus-5` |
| Google Gemini | `https://generativelanguage.googleapis.com` | clave de API de Google AI Studio | `gemini-2.5-pro` |
| OpenAI | `https://api.openai.com/v1` | clave de API de [platform.openai.com](https://platform.openai.com) | `gpt-5.6-sol` |
| GitHub Models (Copilot) | `https://models.github.ai/inference` | token de GitHub con el permiso `models:read` | `gpt-4o` |

El valor por defecto es Ollama, que se ejecuta enteramente en tu máquina — nada sale de ella:

```bash
brew install ollama     # o descárgalo en ollama.com
ollama serve
ollama pull llama3.1
```

Las claves de API se guardan en `db/algorithms.db` y nunca vuelven al navegador: una vez guardadas, el
campo muestra una máscara y se reemplaza escribiendo una nueva.

"GitHub Models (Copilot)" es el endpoint compatible con OpenAI que viene con la cuenta de GitHub.
GitHub Copilot en sí no expone una API de chat para aplicaciones de terceros.

### Un modelo local aconseja

Con Ollama, el asistente explica el catálogo y recomienda un framework y los valores de sus
parámetros, pero nunca guarda un algoritmo: eliges el framework en la barra lateral y rellenas lo
que sugirió. El chat lo avisa en un banner mientras haya un modelo local seleccionado.

Es una decisión medida. Probados `llama3.2:3b` y `llama3.1:8b`, ninguno respondió nunca "ningún
framework hace esto" — ni siquiera en las preguntas donde esa era la única respuesta correcta. Lo
que produjeron fue una configuración que se ejecuta y no resuelve el problema: el runner la acepta
y te enteras mucho después. Un modelo que no sabe decir que no se queda sin el botón que escribe en
tus algoritmos guardados. Para algoritmos construidos y validados por ti, configura un proveedor
alojado.

El catálogo de frameworks además ocupa unos 12k tokens de contexto. Es holgado para Claude y
Gemini, pero justo para modelos locales pequeños — uno con ventana de 8k truncará el catálogo y
elegirá mal el framework. Prefiere un modelo con contexto amplio.

## Encontrar cosas en la barra lateral

Dos filtros, y estrechan juntos. La **caja de texto** alcanza todas las secciones a la vez — un
nombre se encuentra sin saber en cuál vive — y los resultados salen en lista plana, para que un
acierto nunca quede escondido tras un encabezado que habría que abrir antes. La **caja de política de
descubrimiento** deja solo lo que alcanza una política, seguido hacia fuera como lo sigue la sincronización: sus
classifiers, las clases de datos por las que votan, los algoritmos de esas clases de datos y los frameworks
detrás de ellos. Elegir una política convierte toda la barra en el conjunto de trabajo de una regla de
cumplimiento.

El `⋯` de cada sección también elige cómo ordena sus elementos, y la elección se recuerda:

| Sección | Agrupar por |
|---|---|
| Frameworks | categoría, o nada |
| Algoritmos | categoría del framework, clase de datos, política de descubrimiento, o nada |
| Clases de datos | categoría del framework, política de descubrimiento, o nada |
| Classifiers | clase de datos, framework del algoritmo de la clase de datos, framework del classifier, política de descubrimiento, o nada |

Agrupar es una vista, no una clasificación. Un elemento puede aparecer bajo más de un encabezado —
un classifier pertenece a toda política de descubrimiento que lo ejecuta — y lo que no cae en ninguno queda en
**Otros**, que es una respuesta de verdad, no un error.

## Sincronizar con Delphix

**Data Control Tower o un engine — uno u otro.** En *Configuración → Delphix* eliges con qué
integrar:

- **Data Control Tower (DCT)** — donde Delphix pasó a centralizar Continuous Compliance: algoritmos,
  clases de datos, classifiers y políticas de descubrimiento viven en DCT y se ejecutan en sus
  compliance nodes. La herramienta habla con la API `/dct/v3` y se autentica con una clave de API.
- **Continuous Compliance Engine** — un engine solo, a través de su propia Masking API, con usuario
  y contraseña. Allí los mismos objetos se llaman dominios y profile sets.

Nunca los dos a la vez: lo que se guarda aquí refleja una sola instancia. La herramienta usa los
nombres de DCT en ambos casos.

**Una instancia, reflejada.** Conectar trae todo de una vez — todas las políticas de descubrimiento,
classifiers, clases de datos y algoritmos — y los campos de la conexión quedan bloqueados. No hay
nada útil en editar una URL bajo un reflejo de la instancia que esa URL ya no nombra, así que cambiar
de instancia, o pasar de un engine a DCT, es eliminar la integración y configurar la otra.

Tres botones mantienen el reflejo al día:

- **Actualizar desde Delphix** trae todo de nuevo, actualizando lo que ya está aquí.
- **Enviar todo a Delphix** empuja en sentido contrario, en orden de dependencia — algoritmos,
  luego las clases de datos que los nombran, luego los classifiers que votan por ellas, luego las
  políticas que ejecutan los classifiers. Cada objeto sigue teniendo su **Enviar a Delphix** en el
  editor.
- **Eliminar integración** olvida la conexión y borra toda fila vinculada a esa instancia.
  "Vinculada" incluye lo que creaste aquí y enviaste allí, y el diálogo lo dice con todas las
  letras: `delphix_origin` es el único registro del vínculo, y ambos sentidos lo graban. Los
  archivos ya descargados siguen en la carpeta de archivos.

Los algoritmos de fábrica del plugin (`dlpx-core:`) no bajan. Esta herramienta tiene el mismo
plugin, así que una copia guardada de uno de ellos sería una fila que no responde por nada. En DCT,
los objetos de fábrica — algoritmos, clases de datos, classifiers y la política ASDD Standard —
también quedan fuera y nunca se modifican; DCT los lista sin el prefijo (`CM Digits`, `CreditCard`),
y la herramienta empareja un nombre con el otro.

**Qué cambia con DCT.**

- Solo va y viene lo que DCT administra. Los objetos que DCT solo refleja de los engines conectados
  quedan fuera — pertenecen al engine, y se integran a través de él.
- En DCT la identidad de todo objeto es un id, y el nombre puede repetirse. La herramienta actualiza
  tu objeto con ese nombre en lugar de crear otro al lado.
- Una configuración de DCT nombra otro algoritmo por su id. La herramienta traduce en ambos
  sentidos, y la fila de aquí sigue con nombres — que es lo que se ejecuta en local.
- Un archivo subido a DCT pertenece al algoritmo que lo nombró, así que cada algoritmo lleva el suyo.
- DCT no ofrece descarga de archivos subidos: al importar, los archivos de lookup y las listas vienen
  solo como referencia y aparecen en el resumen de lo que falta; el objeto se importa igualmente.
- DCT acepta cualquier carácter en nombres y descripciones, y guarda la descripción entera de una
  política; un engine rechaza algunos caracteres y corta esa descripción en 50.
- Reenviar un objeto que ya está igual allí no lo reescribe. DCT responde HTTP 500 a cualquier
  actualización de un algoritmo Checkdigit, así que un Checkdigit que cambió tiene que borrarse en
  DCT y enviarse de nuevo — el mensaje de error lo dice.

Apunta la herramienta a Delphix en **Configuración → Delphix** y pulsa **Probar conexión**; responde
antes de que guardes nada. Para no guardar el secreto en disco, define `DLPX_DCT_API_KEY` (DCT) o
`DLPX_ENGINE_PASSWORD` (engine) en el entorno — tiene precedencia y el campo pasa a mostrarse de
solo lectura.

### Clases de datos

La sección **Clases de datos** de la barra lateral guarda las clases de datos sensibles — una clase
de datos es un nombre y dos referencias a algoritmo, el por defecto y el de tokenización, y eso es
exactamente lo que se guarda aquí. Crea una en *Clases de datos → ⋯ → Nueva clase de datos*; cada
una tiene el botón **Enviar a Delphix**, que la crea allí, o la actualiza cuando el nombre ya existe.

Enviar una clase de datos **envía antes los algoritmos a los que apunta** — Delphix rechaza una clase
de datos cuyo algoritmo no conoce. Los algoritmos que ya son de Delphix, como los de fábrica
`dlpx-core:`, no se tocan: allí son de solo lectura y ya están bien. Si un algoritmo no se puede
enviar, la clase de datos tampoco va, y el mensaje dice qué algoritmo falló.

Las clases de datos se agrupan por el framework del algoritmo al que apuntan, con las mismas
categorías que todo lo demás. Entre una clase de datos y su categoría hay dos búsquedas, y cualquiera
puede fallar — el algoritmo puede ser uno de fábrica que esta máquina no tiene, y no todo algoritmo
de una instancia se basa en un framework. Esas quedan en **Otros**, que en un engine estándar es
cerca de una quinta parte.

### Classifiers

Los classifiers son lo que usa el descubrimiento para decidir a qué clase de datos pertenece una
columna o un campo. Cada uno se construye sobre uno de cuatro frameworks — **PATH** (el nombre del
campo y de su tabla o archivo), **TYPE** (el tipo y la longitud; *Data type* en DCT), **REGEX** y
**LIST** (una muestra de los valores) — y vota por una clase de datos. La sección **Classifiers** de
la barra lateral los lista por clase de datos; crea uno en *Classifiers → ⋯ → Nuevo classifier*.

El editor explica cada parámetro del framework elegido, y el panel **Prueba** describe un campo —
nombre, tabla, tipo SQL, longitud, valores de muestra — y muestra lo que concluiría el
descubrimiento: la confianza de este classifier (qué ruta, tipo, patrón o lista decidió, valor por
valor) y la de la clase de datos, pesada junto con los demás classifiers guardados para ella, contra
el umbral de la política de descubrimiento. Prueba lo que está en pantalla, así que un cambio se puede
probar antes de guardarlo. Nada se ejecuta en Delphix: la herramienta evalúa los classifiers en
local, leyendo las expresiones regulares como las lee Java. Las pocas construcciones Java que no
reproduce con exactitud se avisan en lugar de aproximarse.

**Enviar a Delphix** crea el classifier allí o lo actualiza; renombrar no es problema, porque Delphix
renombra los classifiers en su lugar. Lo que un classifier usa viaja con él: Delphix rechaza un
classifier cuya clase de datos no tiene, así que la clase de datos va antes cuando esta máquina la
tiene — con sus algoritmos — y los archivos de valores de un classifier LIST se suben cuando Delphix
no los tiene. Importar funciona igual en sentido inverso: un classifier baja con su clase de datos,
los algoritmos de esta y sus archivos de valores.

### Políticas de descubrimiento

Una política de descubrimiento es lo que de verdad ejecuta un job de descubrimiento: los classifiers
que debe probar y el **umbral de asignación** — la confianza que una clase de datos tiene que
alcanzar para que el job la asigne. La sección **Políticas de descubrimiento** de la barra lateral
las lista con su tamaño y umbral; crea una en *Políticas de descubrimiento → ⋯ → Nueva política de
descubrimiento*.

El editor elige los miembros entre los classifiers guardados aquí, filtrando por nombre o clase de
datos. No hay nada que probar en una política: lo que decide una clase de datos son los
classifiers, y se configuran y prueban en su propio editor.

Todo aquello en lo que se apoya una política viaja con ella. Importar una trae los classifiers que
nombra y, a través de ellos, sus clases de datos, los algoritmos de esas clases y los archivos de
valores. **Enviar a Delphix** hace lo contrario: cada miembro va primero, y luego la política se crea
o se actualiza nombrándolos por los ids que devolvió Delphix — una política solo puede referenciar
classifiers que Delphix ya tiene.

**Políticas de descubrimiento preconfiguradas.** *Configuración → Políticas de descubrimiento* lista
las políticas que vienen con la herramienta, cada una con su documentación en PDF y todo lo que
necesita. **Cargar** pregunta el paquete: el **paquete esencial** es lo mínimo para la ley —
documentos de identidad, nombres, contacto, dirección y fecha de nacimiento — y el **paquete
extendido** es la política completa. Cualquiera de los dos crea de una vez la política de
descubrimiento, sus classifiers, clases de datos, algoritmos y archivos. Cargar de nuevo nunca
duplica nada: el botón pasa a ser **Restablecer**, que devuelve cada elemento a como viene y
descarta los cambios hechos en él, y elegir allí el otro paquete cambia uno por otro, quitando lo
que el nuevo no incluye. **Quitar** elimina lo que trajo la política, salvo lo que algo tuyo todavía
usa; lo enviado a Delphix sigue allí. Si un nombre que usa la política ya pertenece a algo que no
vino de ella, la herramienta lista lo que se reemplazaría y pregunta antes. La política lleva el país,
la ley y la versión en el nombre (`CL - Ley 21.719 - v3`), y la tarjeta muestra la versión que viene
con la herramienta **y la fecha en que se generó esa versión**, para saber qué tan vieja es una
política sin abrirla. El formato está en `presets/README.md`.

La lista se agrupa por región — América del Norte, Centroamérica, Caribe, América del Sur, Europa —
y se acota con una caja de filtro (país, ley, número; se ignoran los acentos), los botones de región
y *Solo las cargadas aquí*.

**Descargar paquete.** Cada política también se descarga como un `.zip` que la carga en Delphix sin
esta herramienta: la documentación en los tres idiomas, `import.sh` (Linux y macOS: bash, curl, jq)
e `import.ps1` (Windows PowerShell 5.1, que viene con Windows, o PowerShell 7), y cada objeto ya con
la forma de la API de Data Control Tower y de la Masking API de un engine, con los archivos de lookup
y de listas. El script pregunta primero el idioma de los mensajes, luego DCT o engine, la dirección
y las credenciales, si acepta un certificado autofirmado, y el paquete. Antes de cambiar nada lista
los objetos que ya existen allí con los mismos nombres y pide confirmación: esos se borran antes de
la importación, y lo que Delphix se niegue a borrar — porque algo más lo usa — se actualiza en su
lugar. Cada paso queda en `import-<fecha>.log` junto al script; los secretos, nunca. Ejecutarlo de
nuevo retoma donde se detuvo.

Hoy vienen quince, una por país, todas con umbral de 60. Las cifras de abajo son
del paquete extendido; cada paquete esencial tiene de 11 a 13 clases de datos:

| Política de descubrimiento | Ley | Clases de datos | Classifiers | Algoritmos | Documentación |
|---|---|---|---|---|---|
| [Chile](presets/chile-ley-21719/) | Ley 21.719 | 73 | 134 | 97 | [es](presets/chile-ley-21719/doc.es.pdf) · [en](presets/chile-ley-21719/doc.en.pdf) · [pt-BR](presets/chile-ley-21719/doc.pt-BR.pdf) |
| [México](presets/mexico-lfpdppp/) | LFPDPPP (2025) | 83 | 155 | 148 | [es](presets/mexico-lfpdppp/doc.es.pdf) · [en](presets/mexico-lfpdppp/doc.en.pdf) · [pt-BR](presets/mexico-lfpdppp/doc.pt-BR.pdf) |
| [Panamá](presets/panama-ley-81/) | Ley 81 de 2019 | 76 | 137 | 138 | [es](presets/panama-ley-81/doc.es.pdf) · [en](presets/panama-ley-81/doc.en.pdf) · [pt-BR](presets/panama-ley-81/doc.pt-BR.pdf) |
| [Belice](presets/belize-dpa-2021/) | Data Protection Act, 2021 | 72 | 126 | 84 | [es](presets/belize-dpa-2021/doc.es.pdf) · [en](presets/belize-dpa-2021/doc.en.pdf) · [pt-BR](presets/belize-dpa-2021/doc.pt-BR.pdf) |
| [Brasil](presets/brazil-lgpd/) | LGPD (Lei 13.709/2018) | 84 | 150 | 156 | [es](presets/brazil-lgpd/doc.es.pdf) · [en](presets/brazil-lgpd/doc.en.pdf) · [pt-BR](presets/brazil-lgpd/doc.pt-BR.pdf) |
| [Colombia](presets/colombia-ley-1581/) | Ley 1581 de 2012 | 82 | 145 | 140 | [es](presets/colombia-ley-1581/doc.es.pdf) · [en](presets/colombia-ley-1581/doc.en.pdf) · [pt-BR](presets/colombia-ley-1581/doc.pt-BR.pdf) |
| [Argentina](presets/argentina-ley-25326/) | Ley 25.326 | 83 | 150 | 116 | [es](presets/argentina-ley-25326/doc.es.pdf) · [en](presets/argentina-ley-25326/doc.en.pdf) · [pt-BR](presets/argentina-ley-25326/doc.pt-BR.pdf) |
| [El Salvador](presets/elsalvador-ley-144/) | Decreto 144 (2024) | 85 | 145 | 105 | [es](presets/elsalvador-ley-144/doc.es.pdf) · [en](presets/elsalvador-ley-144/doc.en.pdf) · [pt-BR](presets/elsalvador-ley-144/doc.pt-BR.pdf) |
| [Perú](presets/peru-ley-29733/) | Ley 29733 | 85 | 146 | 119 | [es](presets/peru-ley-29733/doc.es.pdf) · [en](presets/peru-ley-29733/doc.en.pdf) · [pt-BR](presets/peru-ley-29733/doc.pt-BR.pdf) |
| [Ecuador](presets/ecuador-lopdp/) | LOPDP (2021) | 82 | 143 | 107 | [es](presets/ecuador-lopdp/doc.es.pdf) · [en](presets/ecuador-lopdp/doc.en.pdf) · [pt-BR](presets/ecuador-lopdp/doc.pt-BR.pdf) |
| [Uruguay](presets/uruguay-ley-18331/) | Ley 18.331 | 83 | 143 | 111 | [es](presets/uruguay-ley-18331/doc.es.pdf) · [en](presets/uruguay-ley-18331/doc.en.pdf) · [pt-BR](presets/uruguay-ley-18331/doc.pt-BR.pdf) |
| [Costa Rica](presets/costarica-ley-8968/) | Ley 8968 | 81 | 143 | 168 | [es](presets/costarica-ley-8968/doc.es.pdf) · [en](presets/costarica-ley-8968/doc.en.pdf) · [pt-BR](presets/costarica-ley-8968/doc.pt-BR.pdf) |
| [España](presets/spain-lopdgdd/) | RGPD + LOPDGDD | 83 | 149 | 341 | [es](presets/spain-lopdgdd/doc.es.pdf) · [en](presets/spain-lopdgdd/doc.en.pdf) · [pt-BR](presets/spain-lopdgdd/doc.pt-BR.pdf) |
| [Jamaica](presets/jamaica-dpa-2020/) | Data Protection Act, 2020 | 74 | 129 | 83 | [es](presets/jamaica-dpa-2020/doc.es.pdf) · [en](presets/jamaica-dpa-2020/doc.en.pdf) · [pt-BR](presets/jamaica-dpa-2020/doc.pt-BR.pdf) |
| [Reino Unido](presets/uk-gdpr-dpa-2018/) | UK GDPR + DPA 2018 | 73 | 130 | 105 | [es](presets/uk-gdpr-dpa-2018/doc.es.pdf) · [en](presets/uk-gdpr-dpa-2018/doc.en.pdf) · [pt-BR](presets/uk-gdpr-dpa-2018/doc.pt-BR.pdf) |

El descubrimiento no depende solo del nombre de la columna. Las bases de datos rellenan los valores
— una columna CHAR los completa con espacios, un código guardado como texto suele venir con ceros a la
izquierda — y el descubrimiento los prueba tal como llegan; por eso toda política quita el relleno antes de
comparar, y el enmascaramiento lo deja en su lugar: `0012345678` pasa a ser `00` seguido de lo que
`12345678` pasa a ser. Cuando el nombre de la columna no dice nada — `CAMPO1`, `FLD_07`, los nombres
cortos de los sistemas empaquetados — los valores por sí solos encuentran el dato siempre que su
formato sea distintivo: documentos con dígito verificador, correos, teléfonos, tarjetas, lugares,
nombres.

Cada una agrupa sus clases de datos en identificadores directos, cuasi-identificadores y los datos
sensibles que nombra su ley, y enmascara los identificadores nacionales con un dígito verificador
válido donde el número lo tiene — el RUT de Chile, la CURP y el RFC de México, el RUC de persona
natural en Panamá, el CPF, el CNPJ (también el alfanumérico), el PIS, el título electoral y el CNS en Brasil, el NIT en Colombia, el CUIT, el CUIL, el CBU y el CVU en Argentina, el DUI y el NIT en El Salvador, el DNI y el RUC en Perú, la cédula y el RUC en Ecuador, la cédula de identidad y el RUT en Uruguay, y los dos dígitos de control del IBAN costarricense — el único número de Costa Rica que lleva alguno —, y en España la letra del DNI y del NIE, el número de la Seguridad Social, los dígitos de la cuenta y del IBAN, la referencia catastral y el CUPS. El README de cada carpeta explica el diseño y sus límites; el PDF lista cada
clase de datos, classifier, algoritmo y archivo, con ejemplos enmascarados.

Donde Delphix ya tiene un algoritmo que hace el trabajo, las políticas usan el suyo en lugar de
traer uno propio: CM Numeric para montos, Credit Card para números de tarjeta, BloodType SL para
grupos sanguíneos y Brazil CPF. `presets/verify-all.sh` verifica todas las políticas — o las que elijas —
desde la línea de comandos y guarda un log; el `presets/README.md` lo explica, y también lo que un
preset nuevo debe reutilizar.

**Importar.** No hay importación por objeto: conectar la integración trae la instancia entera, y
**Actualizar desde Delphix** lo trae de nuevo. Un algoritmo sobre un framework que la herramienta
no puede ejecutar no se copia — así nunca acabas con un algoritmo guardado que no se puede probar —
y aparece en el resumen de lo que quedó fuera. Lo que un objeto referencia viene con él: los
algoritmos que nombra una configuración, el archivo de lookup, los algoritmos de una clase de datos, los
classifiers de una política.

**Archivos de lookup.** Un archivo subido a la instancia se queda en el almacenamiento de ella:
el algoritmo lleva solo una referencia (`delphix-file://upload/…/NOMBRES.txt`). Importar descarga el
archivo a **Archivos** siempre que la instancia lo permite — el archivo de lookup de un Secure
Lookup y los archivos de valores de un classifier LIST. Para otros frameworks la instancia no ofrece
descarga: la ventana de importación indica esos archivos, y el algoritmo se importa igualmente —
agregue una copia en **Archivos**, conservando el nombre del archivo de la instancia, y se ejecuta
sin ningún cambio.

Cualquier lista con el formato correcto basta para ver el algoritmo funcionando. Para reproducir lo
que produce la instancia, el archivo tiene que coincidir línea por línea: un algoritmo que elige el
sustituto por el hash de la entrada selecciona por posición, así que una lista distinta es un
resultado distinto.

**Exportar.** Cada algoritmo guardado tiene el botón **Enviar a Delphix**. El que vino de la
instancia se actualiza allí; el que construiste aquí se crea. La herramienta recuerda de dónde vino
cada algoritmo, así que exportar dos veces nunca deja un duplicado. Los algoritmos que referencia
van antes, y cualquier archivo que la instancia no podría abrir — una ruta de esta máquina, o un
archivo de la instancia que ya no guarda para un algoritmo nuevo — se sube desde **Archivos**, con
la configuración apuntando a él. Un archivo que falta en esta máquina detiene el envío, y el mensaje
indica cuál.

**Ida y vuelta.** Probar un algoritmo importado con un archivo local no cambia lo que vuelve a la
instancia: la referencia se guarda como la instancia la escribió, y la copia local solo se resuelve
al ejecutar aquí. Ajuste cualquier parámetro, envíelo de vuelta, y la instancia sigue leyendo su
propio archivo. La única forma de romperlo es elegir otro archivo en el formulario de configuración
— eso reemplaza la referencia. El formulario muestra un archivo de la instancia como *nombre (en la
instancia)*, para que nunca se confunda con un campo vacío; una ruta de esta máquina elegida allí se
sube cuando el algoritmo se envía.

**Nombres.** En la instancia el nombre del algoritmo es su identidad y no puede cambiarse, así que
la herramienta sigue la misma regla: los nombres no son editables. Para trabajar con otro nombre,
usa **Duplicar** y dale el nombre a la copia — la copia no queda vinculada, así que enviarla crea
un algoritmo nuevo.

Si el plugin de enmascaramiento de la instancia es más antiguo que el de `lib/`, algunos frameworks
no existirán allí; exportar uno de esos algoritmos falla con un mensaje que lo explica.


## Hooks

La sección **Hooks** de la barra lateral es para los scripts que Delphix ejecuta en puntos de la
vida de un dataset — Configure Clone, Pre-/Post-refresh, Pre-/Post-snapshot, Pre-/Post-start… —,
que Data Control Tower guarda como **hook templates**. Un hook aquí tiene nombre, una
**descripción** de lo que hace, un shell (bash, sh, expect, PowerShell o PowerShell delegado), el
script y los nombres base de las variables de credencial que DCT le entrega (`<BASE>_USER`,
`<BASE>_PASSWORD`).

- **Hooks listos**: *Ejecutar un job de enmascaramiento (DCT)* y *Ejecutar una job collection
  (DCT)*, en bash y en PowerShell (compatible con Windows PowerShell 5.1). Ambos inician el job a
  través de DCT, lo siguen hasta el final y hacen fallar el hook cuando falla — en Configure Clone,
  una VDB solo se entrega enmascarada.
- **Ejecutar en esta máquina**: el script en pantalla se ejecuta aquí — bash o sh en Linux y macOS,
  PowerShell en Windows (o PowerShell 7 donde esté instalado) — con valores de prueba para sus
  variables, la salida apareciendo mientras se imprime, límite de tiempo y botón Detener. Los
  valores de credencial se escriben en cada ejecución y nunca se guardan; los secretos de la propia
  herramienta quedan fuera del entorno del script.
- **Lo que un hook puede leer**: las variables de entorno que Delphix documenta para hooks (Oracle,
  SQL Server, AppData/DB2, credenciales), cada una insertada en el cursor con un clic.
- **Descargar script** lo guarda como `.sh` o `.ps1` para probarlo en otro servidor.
- **Enviar a Delphix** crea o actualiza el hook template en DCT, y *Actualizar desde Delphix* trae
  los hook templates de DCT. Las credenciales nunca viajan: agrega las variables de credencial en el
  template en DCT. Un Continuous Compliance Engine no tiene hook templates, así que esto requiere la
  integración con DCT.

## Idioma de la interfaz

La UI está disponible en inglés, portugués (BR) y español. Por defecto sigue el idioma del
navegador; para fijar uno, haz clic en una bandera al pie de la barra lateral. Se aplica al
instante. Una vez fijado un idioma aparece un enlace **auto** junto a las banderas, que vuelve a
seguir el navegador. La elección se guarda en el servidor, así que aplica a cualquier navegador que
abra la aplicación.

## AlgorithmRunner

`AlgorithmRunner.java` es un proceso Java de vida corta (un fork por petición) que:

1. Recibe JSON por stdin con `command`, `framework`, `config`, `input`, `key`
2. Instancia la clase del framework mediante reflection
3. Aplica la configuración con `ComponentConfigurator.applyConfiguration`
4. Construye un `ComponentService` mínimo con un `CryptoService` derivado de la clave
5. Llama a `setup()` de forma recursiva, luego `validate()` y luego `mask(input)`
6. Devuelve el resultado como JSON por stdout


## Compilar el AlgorithmRunner

Si modificas `AlgorithmRunner.java`:

```bash
cd java-runner
javac --release 11 -cp "$(ls ../lib/*.jar | tr '\n' ':')" AlgorithmRunner.java
jar cfe AlgorithmRunner.jar AlgorithmRunner *.class
```

El `--release 11` importa: el jar se versiona y nada lo recompila en la máquina que instala la
herramienta, así que este bytecode es el que ejecuta todo usuario. Sin la bandera, `javac` apunta
a la JDK que tengas, y quien esté en un Java más antiguo choca con `UnsupportedClassVersionError`
en su primera operación de enmascaramiento. Java 11 es el piso que prometen los requisitos
previos y los instaladores.

## Licencia

[Mozilla Public License 2.0](LICENSE). Las modificaciones a los archivos de este proyecto siguen
abiertas; puedes combinarlo con código bajo otras licencias. Los jars de Delphix que carga en
tiempo de ejecución no están cubiertos por esta licencia y no se distribuyen aquí.

**Marcas y vinculación.** Delphix, Delphix Continuous Compliance y los demás nombres de producto
citados aquí son marcas de sus respectivos dueños. Este proyecto es independiente: no tiene
vinculación con ellos, no está respaldado ni soportado por ellos, y usarlo no concede ningún
derecho sobre el software de Delphix que carga.
