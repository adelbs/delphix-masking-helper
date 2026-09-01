# Delphix Masking Helper

[English](README.md) · [Português (BR)](README.pt-BR.md) · **Español**

Un compañero local para el plugin de enmascaramiento de Delphix. Ayuda a **entender** cómo se
comporta cada framework, **probar** un algoritmo con valores reales y **construir** un algoritmo ya
configurado a partir de un problema descrito en lenguaje natural — todo sin crear un Rule Set ni
ejecutar un Job en un Masking Engine.

> **Necesitas el SDK de Delphix para ejecutar esto.** Los algoritmos viven en jars licenciados del
> producto Delphix, que **no** se distribuyen aquí. Solicita el Masking Devkit (SDK) a Delphix y
> coloca quince jars en `lib/` — consulta [Bibliotecas de Delphix](#bibliotecas-de-delphix) más
> abajo. Referencia: [Compliance Algorithm SDK](https://portal.perforce.com/s/article/Compliance-Algorithm-SDK-for-Guidewire-1728062704114).

![El asistente creando un algoritmo y el algoritmo siendo probado](docs/demo.gif)

<sub>Grabado con el proveedor local por defecto (Ollama · `llama3.1:8b`) en un M1 Pro. La
respuesta del modelo está acelerada — en local tarda alrededor de un minuto. Todos los valores
enmascarados son salida real del plugin.</sub>

## Cómo funciona

El servidor Node expone una API REST que delega cada operación en `AlgorithmRunner.jar`, que carga y ejecuta los algoritmos mediante reflection. El frontend React lo sirve Vite en desarrollo (con hot-reload) y Express en producción.

## Guía de los algoritmos

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
javac -cp "$(ls ../lib/*.jar | tr '\n' ':')" AlgorithmRunner.java
jar cfe AlgorithmRunner.jar AlgorithmRunner *.class
```

## Licencia

[Mozilla Public License 2.0](LICENSE). Las modificaciones a los archivos de este proyecto siguen
abiertas; puedes combinarlo con código bajo otras licencias. Los jars de Delphix que carga en
tiempo de ejecución no están cubiertos por esta licencia y no se distribuyen aquí.
