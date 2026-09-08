# Delphix Masking Helper

[English](README.md) · [Português (BR)](README.pt-BR.md) · **Español**

🌐 **[Sitio web](https://adelbs.github.io/delphix-masking-helper/index.es.html)** — qué hace la herramienta, y la referencia completa de los algoritmos, en tres idiomas.

Un compañero local para el plugin de enmascaramiento de Delphix, que cubre la vida entera de un
algoritmo. Ayuda a **entender** cómo se comporta cada framework, **probar** un algoritmo con
valores reales, **construir** un algoritmo ya configurado a partir de un problema descrito en
lenguaje natural y **sincronizar** con un Masking Engine — trayendo sus algoritmos para trabajar y
devolviendo los tuyos. Todo sin crear un Rule Set ni ejecutar un masking job.

> ### Proyecto independiente, y requiere licencia Delphix activa
>
> **Sin ninguna relación con Delphix.** Este es un proyecto open source independiente. No está
> hecho, respaldado, revisado ni soportado por Delphix ni por sus titulares, y nada aquí es un
> producto oficial. Delphix y los nombres de producto usados aquí son marcas de sus respectivos
> dueños.
>
> **Se requiere una licencia Delphix activa.** Los algoritmos de enmascaramiento viven en jars
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

El servidor Node expone una API REST que delega cada operación en `AlgorithmRunner.jar`, que carga y ejecuta los algoritmos mediante reflection. El frontend React lo sirve Vite en desarrollo (con hot-reload) y Express en producción.

## Guía de los algoritmos

📖 **[Leer la referencia de los algoritmos en línea](https://adelbs.github.io/delphix-masking-helper/algorithms.es.html)** — el mismo contenido de los PDF, en tres idiomas.

Cada algoritmo abre con dos pestañas: **Probar** y **Documentación**. La pestaña de documentación
muestra la sección de ese algoritmo en la guía de referencia, en el idioma de la interfaz — el
mismo contenido de los PDF de abajo, leído de la misma fuente, así que nunca divergen.

El directorio [`docs/`](docs/) contiene una guía de referencia de los 31 algoritmos del plugin, en tres idiomas:

| Idioma | Archivo |
|---|---|
| Español | [`docs/delphix-algorithms-guide.es.pdf`](docs/delphix-algorithms-guide.es.pdf) |
| English | [`docs/delphix-algorithms-guide.en.pdf`](docs/delphix-algorithms-guide.en.pdf) |
| Português (BR) | [`docs/delphix-algorithms-guide.pt-BR.pdf`](docs/delphix-algorithms-guide.pt-BR.pdf) |

Para cada algoritmo la guía explica qué hace, ejemplos de entrada → salida y la descripción de todos los parámetros de configuración. Los algoritmos se agrupan según las mismas categorías de la barra lateral de la UI. Incluye además tres apéndices: conceptos transversales (determinismo, papel de la clave, algoritmos que pueden no enmascarar nada), el catálogo de las 62 instancias `dlpx-core:` incorporadas en el plugin y las limitaciones del runner standalone.

Todos los pares entrada → salida se generaron ejecutando los algoritmos en `AlgorithmRunner` — no son ilustrativos.

### Regenerar los PDFs

Las fuentes están en `docs/src/` (un HTML por idioma + `guide.css` compartido). Después de editar, recompila:

```bash
./docs/build.sh            # todos los idiomas
./docs/build.sh pt-BR es   # solo los idiomas indicados
```

El build usa Chrome headless y fuentes instaladas en macOS (Iowan Old Style, Seravek, Menlo), así que los PDFs deben regenerarse en un Mac para conservar la tipografía.

## Bibliotecas de Delphix

El tester ejecuta los algoritmos reales del plugin de enmascaramiento de Delphix, así que
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
| `dlpx-helper logs` | sigue el log |
| `dlpx-helper update` | pasa a la release más nueva y recompila |
| `dlpx-helper uninstall` | lo elimina (pregunta antes) |

**La instalación queda fijada a una release, no a la punta de `main`.** El script le pregunta al
remoto cuál es la etiqueta `vX.Y.Z` más nueva y hace checkout de ella, así que un commit enviado
después de la última release nunca te llega; las etiquetas de prelanzamiento como `v2.0.0-rc1`
también se omiten. Para sobrescribirlo usa `DLPX_REF` — `DLPX_REF=v1.0.0` fija una release
anterior, y un nombre de rama hace que siga esa rama. Si el repositorio no tiene ninguna etiqueta
de release, el script recurre a la rama por defecto y lo avisa.

Volver a ejecutar el script en una máquina que ya lo tiene ofrece **actualizar** o **eliminar**.
Actualizar nunca toca `db/`, donde viven tus algoritmos guardados y tu configuración. Desinstalar
borra todo, por eso avisa antes — exporta desde **Pruebas/Algoritmos Guardados → Exportar** si
quieres conservar algo.

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
**Pruebas/Algoritmos Guardados**, listo para ejecutar.

Antes de guardar, el servidor **ejecuta el algoritmo de verdad** con la configuración que produjo
el modelo. Si el runner la rechaza — un parámetro inventado, una combinación inválida — no se
guarda nada y el error aparece en el chat. Una configuración alucinada nunca se convierte en una
prueba guardada.

El asistente conoce los 31 algoritmos: su system prompt se construye con las mismas descripciones
que muestra la UI, más el JSON Schema real de cada algoritmo leído del plugin.

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

Las claves de API se guardan en `db/tests.db` y nunca vuelven al navegador: una vez guardadas, el
campo muestra una máscara y se reemplaza escribiendo una nueva.

"GitHub Models (Copilot)" es el endpoint compatible con OpenAI que viene con la cuenta de GitHub.
GitHub Copilot en sí no expone una API de chat para aplicaciones de terceros.

> **Sobre los modelos locales.** El catálogo de algoritmos ocupa unos 12k tokens de contexto. Es
> holgado para Claude y Gemini, pero justo para modelos locales pequeños — uno con ventana de 8k
> truncará el catálogo y elegirá mal el algoritmo. Prefiere un modelo con contexto amplio.

## Sincronizar con un Masking Engine

Apunta la herramienta a una instancia Delphix en **Configuración → Delphix** — dirección, usuario
y contraseña — y pulsa **Probar conexión**; responde antes de que guardes nada.

**Importar.** *Pruebas/Algoritmos Guardados → Importar de Delphix* lista lo que tiene la instancia.
Lo que esté sobre un framework que la herramienta no puede ejecutar aparece, pero no es
seleccionable, así nunca acabas con un algoritmo guardado que no se puede probar.

**Archivos de lookup.** Un archivo subido a la instancia se queda en el almacenamiento de ella:
el algoritmo lleva solo una referencia (`delphix-file://upload/…/NOMBRES.txt`), e importar trae la
referencia, nunca el contenido. La ventana de importación indica qué archivos lee el algoritmo y
esta máquina no tiene, y el algoritmo se importa igualmente — solo que no se ejecuta mientras no
haya una copia. Agregue una en **Archivos**, conservando el nombre del archivo de la instancia, y
el algoritmo importado se ejecuta sin ningún cambio.

Cualquier lista con el formato correcto basta para ver el algoritmo funcionando. Para reproducir lo
que produce la instancia, el archivo tiene que coincidir línea por línea: un algoritmo que elige el
sustituto por el hash de la entrada selecciona por posición, así que una lista distinta es un
resultado distinto.

**Exportar.** Cada algoritmo guardado tiene el botón **Enviar a Delphix**. El que vino de la
instancia se actualiza allí; el que construiste aquí se crea. La herramienta recuerda de dónde vino
cada algoritmo, así que exportar dos veces nunca deja un duplicado.

**Ida y vuelta.** Probar un algoritmo importado con un archivo local no cambia lo que vuelve a la
instancia: la referencia se guarda como la instancia la escribió, y la copia local solo se resuelve
al ejecutar aquí. Ajuste cualquier parámetro, envíelo de vuelta, y la instancia sigue leyendo su
propio archivo. La única forma de romperlo es elegir otro archivo en el formulario de configuración
— eso reemplaza la referencia. El formulario muestra un archivo de la instancia como *nombre (en la
instancia)*, para que nunca se confunda con un campo vacío, y exportar una configuración que apunta
a una ruta de esta máquina avisa que la instancia no tiene esa ruta.

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

1. Recibe JSON por stdin con `command`, `algorithm`, `config`, `input`, `key`
2. Instancia la clase del algoritmo mediante reflection
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
