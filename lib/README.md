# lib/ — Delphix libraries

**This directory is intentionally empty in the repository.** The jars it needs are Delphix
product files and are not redistributed here. You supply them from the Delphix Masking Devkit.

## Getting them

Request the **Masking Devkit (SDK)** for your Masking Engine version from Delphix (through your
account team or the support portal). Unpack it and copy the jars below out of `sdkTools/lib/`
into this directory.

## What to copy

Fifteen jars, verified as the minimum needed to run every algorithm the tester exposes. Versions
do not need to match exactly — the server matches by filename prefix, so whatever ships in your
SDK works.

| Jar | Why it is needed |
|---|---|
| `delphix-algorithm-plugin-*.jar` | The algorithms themselves |
| `masking-extensibility-api-*.jar` | The plugin API the runner compiles against |
| `jackson-annotations-*.jar` | Config deserialization |
| `jackson-core-*.jar` | Config deserialization |
| `jackson-databind-*.jar` | Config deserialization |
| `jackson-datatype-jdk8-*.jar` | `Optional` fields in configs |
| `jackson-datatype-jsr310-*.jar` | Date/time fields in configs |
| `jackson-module-jsonSchema-*.jar` | Generates the schemas that drive the config form |
| `guava-*.jar` | Plugin runtime dependency |
| `failureaccess-*.jar` | Guava runtime dependency |
| `ant-*.jar` | Plugin runtime dependency |
| `commons-codec-*.jar` | `FileReference` support (lookup files) |
| `commons-compiler-*.jar` | Numeric Expression |
| `commons-lang-*.jar` | Plugin runtime dependency |
| `janino-*.jar` | Numeric Expression |

Everything else in the SDK's `sdkTools/lib/` belongs to the `maskApp` CLI (Spring Boot, logback,
hadoop…). Copying it all also works, but it only bloats the classpath.

## Checking it worked

Start the server. If anything is missing it says so on startup and names the prefixes it could
not find:

```bash
npm run dev
```

To point at a plugin jar outside this directory, set `DLPX_PLUGIN_JAR` to its full path.
