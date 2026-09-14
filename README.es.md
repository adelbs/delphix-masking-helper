# Delphix Masking Helper

[English](README.md) · [Português (BR)](README.pt-BR.md) · **Español**

🌐 **[Sitio web](https://adelbs.github.io/delphix-masking-helper/index.es.html)** — qué hace la herramienta, y la referencia completa de los frameworks, en tres idiomas.

Un compañero local para el plugin de enmascaramiento de Delphix, que cubre la vida entera de un
algoritmo. Ayuda a **entender** cómo se comporta cada uno de los 31 frameworks de enmascaramiento,
**probar** un algoritmo con valores reales, **construir** un algoritmo ya configurado a partir de
un problema descrito en lenguaje natural y **sincronizar** con un Masking Engine — trayendo sus
algoritmos para trabajar y devolviendo los tuyos. Todo sin crear un Rule Set ni ejecutar un
masking job.

> **La nomenclatura sigue la de Delphix.** Un **framework** es una técnica de enmascaramiento que
> ofrece el plugin — Secure Lookup, Character Mapping, Date Shift. Configurar uno produce un
> **algoritmo**: con nombre, guardado y listo para usar. La barra lateral lista frameworks; lo que
> guardas es un algoritmo.

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

![El asistente construyendo un algoritmo, un algoritmo siendo probado, y algoritmos sincronizándose con una instancia Delphix](docs/demo.gif)

<sub>Tres cosas, en este orden: pedir un algoritmo al asistente y verlo construir y validar uno;
ejecutar un algoritmo con un valor real; importar de una instancia Delphix y devolver uno. Grabado
con el proveedor local por defecto (Ollama · `llama3.1:8b`) en un M1 Pro — la respuesta del modelo
está acelerada, porque en local tarda alrededor de un minuto. Todos los valores enmascarados son
salida real del plugin, y la instancia es real.</sub>

## Cómo funciona

El servidor Node expone una API REST que delega cada operación en `AlgorithmRunner.jar`, que carga y ejecuta los frameworks mediante reflection. El frontend React lo sirve Vite en desarrollo (con hot-reload) y Express en producción.

## Guía de los frameworks

📖 **[Leer la referencia de los frameworks en línea](https://adelbs.github.io/delphix-masking-helper/frameworks.es.html)** — el mismo contenido de los PDF, en tres idiomas.

Cada framework abre con dos pestañas: **Probar** y **Documentación**. La pestaña de documentación
muestra la sección de ese framework en la guía de referencia, en el idioma de la interfaz — el
mismo contenido de los PDF de abajo, leído de la misma fuente, así que nunca divergen.

La pantalla de classifiers tiene la misma pestaña **Documentación**: abre con cómo el profiling
decide un dominio, seguida de la sección del framework de classifier en cuestión.

El directorio [`docs/`](docs/) contiene una guía de referencia de los 31 frameworks del plugin, en tres idiomas:

| Idioma | Archivo |
|---|---|
| Español | [`docs/delphix-frameworks-guide.es.pdf`](docs/delphix-frameworks-guide.es.pdf) |
| English | [`docs/delphix-frameworks-guide.en.pdf`](docs/delphix-frameworks-guide.en.pdf) |
| Português (BR) | [`docs/delphix-frameworks-guide.pt-BR.pdf`](docs/delphix-frameworks-guide.pt-BR.pdf) |

Para cada framework la guía explica qué hace, ejemplos de entrada → salida y la descripción de todos los parámetros de configuración. Los frameworks se agrupan según las mismas categorías de la barra lateral de la UI. La Parte 10 trata el descubrimiento de dato sensible: cómo se decide un dominio, y los frameworks de classifier `PATH`, `TYPE`, `REGEX` y `LIST`. Incluye además tres apéndices: conceptos transversales (determinismo, papel de la clave, frameworks que pueden no enmascarar nada), el catálogo de los 59 algoritmos `dlpx-core:` incorporadas en el plugin y las limitaciones del runner standalone.

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
él.

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

> **Sobre los modelos locales.** El catálogo de frameworks ocupa unos 12k tokens de contexto. Es
> holgado para Claude y Gemini, pero justo para modelos locales pequeños — uno con ventana de 8k
> truncará el catálogo y elegirá mal el framework. Prefiere un modelo con contexto amplio.

## Encontrar cosas en la barra lateral

Dos filtros, y estrechan juntos. La **caja de texto** alcanza todas las secciones a la vez — un
nombre se encuentra sin saber en cuál vive — y los resultados salen en lista plana, para que un
acierto nunca quede escondido tras un encabezado que habría que abrir antes. La **caja de profile
set** deja solo lo que alcanza un set, seguido hacia fuera como lo sigue la sincronización: sus
classifiers, los dominios por los que votan, los algoritmos de esos dominios y los frameworks
detrás de ellos. Elegir un set convierte toda la barra en el conjunto de trabajo de una regla de
cumplimiento.

El `⋯` de cada sección también elige cómo ordena sus elementos, y la elección se recuerda:

| Sección | Agrupar por |
|---|---|
| Frameworks | categoría, o nada |
| Algoritmos | categoría del framework, dominio, profile set, o nada |
| Dominios | categoría del framework, profile set, o nada |
| Classifiers | dominio, framework del algoritmo del dominio, framework del classifier, profile set, o nada |

Agrupar es una vista, no una clasificación. Un elemento puede aparecer bajo más de un encabezado —
un classifier pertenece a todo profile set que lo ejecuta — y lo que no cae en ninguno queda en
**Otros**, que es una respuesta de verdad, no un error.

## Sincronizar con un Masking Engine

**Una instancia, reflejada.** Conectar una instancia en *Configuración → Delphix* trae el engine
entero de una vez — todos los profile sets, classifiers, dominios y algoritmos — y los campos de la
conexión quedan bloqueados. No hay nada útil en editar una URL bajo un reflejo de la instancia que
esa URL ya no nombra, así que cambiar de engine es eliminar la integración y configurar la otra.

Tres botones mantienen el reflejo al día:

- **Actualizar desde Delphix** trae todo de nuevo, actualizando lo que ya está aquí.
- **Enviar todo a Delphix** empuja en sentido contrario, en orden de dependencia — algoritmos,
  luego los dominios que los nombran, luego los classifiers que votan por ellos, luego los sets que
  ejecutan los classifiers. Cada objeto conserva su **Enviar a Delphix** en su editor.
- **Eliminar integración** olvida la conexión y borra toda fila vinculada a ese engine.
  "Vinculada" incluye lo que construiste aquí y enviaste allí, y el diálogo lo dice con todas las
  letras: `delphix_origin` es el único registro del vínculo, y los dos sentidos lo escriben. Los
  archivos ya descargados siguen en la carpeta de archivos.

Las instancias de plugin del propio engine (`dlpx-core:`) no bajan. Esta herramienta tiene el mismo
plugin, así que una copia guardada de una de ellas sería una fila que no responde por nada.

Apunta la herramienta a una instancia Delphix en **Configuración → Delphix** — dirección, usuario
y contraseña — y pulsa **Probar conexión**; responde antes de que guardes nada.

### Dominios

La sección **Dominios** de la barra lateral guarda los dominios de datos sensibles — en la
instancia un dominio es un nombre y dos referencias a algoritmo, y eso es exactamente lo que se
guarda aquí. Crea uno en *Dominios → ⋯ → Nuevo dominio*, o trae los de la instancia con *Importar
de Delphix*; cada uno tiene el botón **Enviar a Delphix**, que lo crea allí, o lo actualiza cuando
el nombre ya existe.

Enviar un dominio **envía antes los algoritmos a los que apunta** — la instancia rechaza un dominio
cuyo algoritmo no conoce. Los algoritmos que ya son de la instancia, como los integrados
`dlpx-core:`, no se tocan: allí son de solo lectura y ya están bien. Si un algoritmo no puede
enviarse, el dominio tampoco se envía, y el mensaje dice qué algoritmo falló.

Los dominios se agrupan por el framework del algoritmo al que apuntan, con las mismas categorías
que el resto. Entre un dominio y su categoría hay dos búsquedas, y cualquiera puede fallar — el
algoritmo puede ser un integrado que esta máquina no tiene, y no todo algoritmo de una instancia
está basado en framework. Esos caen en **Otros**, que en una instancia estándar es cerca de un
quinto.

### Classifiers

Los classifiers son lo que el profiling usa para decidir a qué dominio pertenece una columna o un
campo. Cada uno se construye sobre uno de cuatro frameworks — **PATH** (el nombre del campo y de su
tabla o archivo), **TYPE** (el tipo y la longitud), **REGEX** y **LIST** (una muestra de los
valores) — y vota por un dominio. La sección **Classifiers** de la barra lateral los lista por
dominio; crea uno en *Classifiers → ⋯ → Nuevo classifier*.

El editor explica cada parámetro del framework elegido, y el panel **Prueba** describe un campo —
nombre, tabla, tipo SQL, longitud, valores de muestra — y muestra lo que concluiría el profiling:
la confianza de este classifier (qué ruta, tipo, patrón o lista decidió, valor por valor) y la del
dominio, sopesado junto con los demás classifiers guardados para él, frente al umbral del profile
set. Prueba lo que está en pantalla, así que un cambio se puede probar antes de guardarlo. Nada se
ejecuta en la instancia: la herramienta evalúa los classifiers localmente, leyendo las expresiones
regulares como las lee Java. Las pocas construcciones de Java que no reproduce con exactitud se
avisan en lugar de aproximarse.

**Enviar a Delphix** crea el classifier en la instancia o lo actualiza; renombrar no es problema,
porque la instancia renombra los classifiers en su lugar. Lo que un classifier usa va con él: la
instancia rechaza un classifier cuyo dominio no tiene, así que el dominio va antes cuando esta
máquina lo tiene — junto con sus algoritmos — y los archivos de valores de un classifier LIST se
suben cuando la instancia no los tiene. Importar hace lo mismo en sentido inverso: el classifier
viene con su dominio, los algoritmos de ese dominio y sus archivos de valores.

### Profile sets

Un profile set es lo que un job de profiling ejecuta de verdad: los classifiers que debe probar y
el **umbral de asignación** — la confianza que un dominio debe alcanzar para que el job se lo
asigne. La sección **Profile Sets** de la barra lateral los lista con su tamaño y su umbral; crea
uno en *Profile Sets → ⋯ → Nuevo profile set*.

El editor elige los miembros entre los classifiers guardados aquí, filtrando por nombre o dominio.
No hay nada que probar en un set: quien decide el dominio son los classifiers, y se configuran y se
prueban en su propio editor.

Todo aquello en lo que un set se apoya viaja con él. Importar uno trae los classifiers que nombra
y, a través de ellos, sus dominios, los algoritmos de esos dominios y los archivos de valores.
**Enviar a Delphix** hace lo inverso: cada miembro va primero, y el set se crea o actualiza
nombrándolos por los ids que devolvió la instancia — un set solo puede referenciar classifiers que
la instancia ya tiene.

**Profile sets preconfigurados.** *Configuración → Profile Sets* lista profile sets que vienen con
la herramienta, cada uno con su documentación en PDF y todo lo que necesita. **Cargar** crea de una
vez el set, sus classifiers, dominios, algoritmos y archivos. Cargarlo de nuevo no duplica nada: el
botón pasa a ser **Restablecer**, que devuelve cada elemento a su estado original y descarta los
cambios que se le hayan hecho. Si un nombre que usa el set ya pertenece a algo que no vino de él, la
herramienta lista lo que se reemplazaría y pregunta antes. El formato está en `presets/README.md`.

**Importar.** No hay importación por objeto: conectar la integración trae el engine entero, y
**Actualizar desde Delphix** lo trae de nuevo. Un algoritmo sobre un framework que la herramienta
no puede ejecutar no se copia — así nunca acabas con un algoritmo guardado que no se puede probar —
y aparece en el resumen de lo que quedó fuera. Lo que un objeto referencia viene con él: los
algoritmos que nombra una configuración, el archivo de lookup, los algoritmos de un dominio, los
classifiers de un set.

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

Si prefieres no guardar la contraseña en disco, define `DLPX_ENGINE_PASSWORD` en el entorno — tiene
precedencia y el campo pasa a mostrarse de solo lectura.

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
