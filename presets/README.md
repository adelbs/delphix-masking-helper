# Pre-configured discovery policies

Each folder here is one discovery policy shipped with the tool, listed under
**Settings → Discovery Policies**. Loading it creates the policy and everything it leans on — its
classifiers, their data classes, those data classes' algorithms and the files they read — as one of two
packs: the **essential pack**, the minimum for its law, or the **extended pack**, all of it. Loading
it again is a **reset**: the same rows are found and put back the way they ship, never duplicated.
**Unload** removes what it brought.

```
presets/
└── <id>/                  lower-case letters, digits and hyphens; the folder name is the id
    ├── preset.json        what gets created
    ├── files/             files the configurations read (optional)
    ├── doc/               what the documentation says about the set (see Documentation)
    └── doc.<locale>.pdf   documentation, per language: en, pt-BR, es — generated
```

Folders starting with `_` are not presets: `_doc/` holds the documentation builder they share,
`_lib/` the helpers every builder uses (see [Writing a preset](#writing-a-preset)), and `_logs/` the
logs of [`verify-all.sh`](#checking-every-preset), which git ignores.

The documentation button serves the PDF in the interface language, falling back to English and
then to whichever exists.

The app reads nothing else in the folder, so a preset can keep whatever produces it next to the
output. The fifteen that ship share one layout: `build.mjs` generates `preset.json` and `files/` from
its own definitions and the raw lists in `source/`, and `verify.mjs` checks the result — reviewing
every classifier, discovery sample columns with the local evaluator in `classifiers/` and masking
sample values through the running app. Each folder's `README.md` explains the design of its set.

| Folder | Discovery policy |
|---|---|
| [`chile-ley-21719/`](chile-ley-21719/) | Chile — Ley 21.719 |
| [`mexico-lfpdppp/`](mexico-lfpdppp/) | Mexico — LFPDPPP (2025) |
| [`panama-ley-81/`](panama-ley-81/) | Panama — Ley 81 de 2019 |
| [`belize-dpa-2021/`](belize-dpa-2021/) | Belize — Data Protection Act, 2021 |
| [`brazil-lgpd/`](brazil-lgpd/) | Brazil — LGPD (Lei 13.709/2018) |
| [`colombia-ley-1581/`](colombia-ley-1581/) | Colombia — Ley 1581 de 2012 |
| [`argentina-ley-25326/`](argentina-ley-25326/) | Argentina — Ley 25.326 |
| [`elsalvador-ley-144/`](elsalvador-ley-144/) | El Salvador — Decreto 144 (2024) |
| [`peru-ley-29733/`](peru-ley-29733/) | Peru — Ley 29733 |
| [`ecuador-lopdp/`](ecuador-lopdp/) | Ecuador — LOPDP (2021) |
| [`uruguay-ley-18331/`](uruguay-ley-18331/) | Uruguay — Ley 18.331 |
| [`costarica-ley-8968/`](costarica-ley-8968/) | Costa Rica — Ley 8968 |
| [`spain-lopdgdd/`](spain-lopdgdd/) | Spain — GDPR and Ley Orgánica 3/2018 (LOPDGDD) |
| [`jamaica-dpa-2020/`](jamaica-dpa-2020/) | Jamaica — Data Protection Act, 2020 |
| [`uk-gdpr-dpa-2018/`](uk-gdpr-dpa-2018/) | United Kingdom — UK GDPR and Data Protection Act 2018 |

## Writing a preset

Start from the preset closest to the new one — same language, same kind of identity number — and
copy its `build.mjs` and `verify.mjs`. What the existing ones learned the hard way is in `_lib/`, and
a new preset should use it rather than solve it again:

- **Padded values** ([`_lib/detect.mjs`](_lib/detect.mjs)). Discovery tests values as the database
  hands them over: a CHAR column pads with spaces, a code kept as text with zeros on the left. Every
  Regex pattern takes `cleaning()`, which strips the spaces, and `zeroPadded()`, which lets a pattern
  that starts with a digit take zeros on the left. A List classifier compares the whole value,
  padding included, unless it splits it into words: `byList` looks single-word lists up word by word
  and turns multi-word lists into a Regex classifier (`… - Values`) with `valuePatterns()`. Patterns
  for accented words use `(?iu)`: the engine's case-insensitive flag alone folds ASCII only.
- **Padding stays in place when masking.** The Character Mappings run with `preserveLeadingZeros`.
  The patterns of the Regex Decompose at the **top** of each data class get `keepingZeros()`, which sets
  the zeros on the left apart in a group of their own — in a loop at the end of `build.mjs`, and
  only there: inside a chain, a step may read a digit at a fixed position, and an optional zero would
  shift it. Where a zero is a digit and not padding — the body of a number fed to a Check Digit, a
  fixed-width segment — use a Character Mapping without `preserveLeadingZeros` (the presets call it
  `fixedWidth()`), or that zero is never masked.
- **Tables of codes.** A Data Cleansing of place codes is built with `codeCleansing()`, which looks
  the code up without its zeros on the left and keeps them where they were; the build fails if two
  codes become the same once stripped. It is opt-in: a check-digit table must not use it, because
  there the zeros count.
- **What an engine refuses** ([`_lib/engine-text.mjs`](_lib/engine-text.mjs)). On a Continuous
  Compliance Engine, the names and descriptions of profile sets, classifiers and domains (discovery
  policies, classifiers and data classes in DCT terms) cannot hold any of
  ``~!@#$%^&*()"?:;,/\`+=[]{}|<>'``, and a profile set description is at most 50 characters. Data
  Control Tower has neither limit, but a preset has to load on both. Every
  `build.mjs` calls `engineTextProblems()` and fails before writing, so a policy that would not load on
  an engine is never generated.
- **Algorithms that come with the engine** ([`_lib/engine-algorithms.mjs`](_lib/engine-algorithms.mjs)).
  Before building an algorithm, check whether the engine already has one that does the job:
  **CM Numeric** for amounts, **Credit Card** for card numbers, **BloodType SL** for blood groups,
  **Brazil CPF**. A data class names it as `ENGINE.CM_NUMERIC` and so on (`dlpx-core:<name>`): it is not
  shipped in `preset.json`, the documentation names it as the engine's own, and `verify.mjs` runs it
  through the runner's catalog. The file also records the built-ins that were compared and left
  aside, and why — check there before trying one again.
- **Columns with names that say nothing.** Give every data class whose values have a distinctive shape
  a value classifier, so a column called `FIELD1` or `PFNOM` is still found. In `verify.mjs`, add new
  test columns **at the end** of `COLUMNS`: the test values come from a seeded generator, and a column
  inserted in the middle changes the values of every column after it.

Then run `build.mjs`, `verify.mjs` and `_doc/build.mjs <id>` (with the app running), and bump
`VERSION` and `VERSION_DATE` together whenever a policy that has shipped changes.

## Checking every preset

```bash
presets/verify-all.sh
```

Runs the `verify.mjs` of every preset, or of the ones you pick. It asks which presets (all, or
numbers, names or a unique prefix such as `chile`), what to check — `classifiers`, in seconds and
with nothing running, or `full`, which also masks through the running app and takes minutes per
preset — and whether to rebuild first. Presets are found by folder, so a new one is checked as
soon as it has a `verify.mjs`. Every run writes the whole output to `presets/_logs/`, ends with a
summary and the app's own review of each preset, and exits non-zero when anything fails.

```bash
presets/verify-all.sh all --mode classifiers --yes
presets/verify-all.sh chile peru --mode full --build --jobs 3
```

`--mode`, `--build`, `--jobs N` (presets at a time), `--url` (the app, default `$DLPX_URL` or
`http://localhost:3000`) and `--yes` (ask nothing) answer the questions from the command line;
`--help` lists them.

## Documentation

Every preset ships a PDF per language that lists everything in it and explains it. The PDF is for
anyone running Delphix — Data Control Tower or a Continuous Compliance Engine — with or without this tool: it describes the policy in
Delphix's own terms — discovery policy, classifiers and their frameworks, data classes, algorithms, rule sets,
discovery and masking jobs — and names nothing of this tool, neither its screens nor its
scripts. The builder refuses text that does. The PDF is generated, and most of it comes from
`preset.json` itself, so it cannot drift from the policy:

- the cover and contents, with the policy's counts, version and threshold;
- how discovery and masking work, common to every preset;
- the essential and extended packs, with their counts and the essential data classes, which are also
  marked in the data class table and chapters;
- a table of all data classes, how each is found and which algorithm masks it;
- a chapter per data class group, and in it every data class: **what it is** and **how it is masked**
  (written), every classifier with its rules (generated — column-name alternatives, accepted
  types, value patterns, lists with sizes and first values), the tree of algorithms it uses
  (generated), and examples masked by the running app;
- appendices with every algorithm and its full configuration, every file, the column-name
  exclusion lists, and every classifier of the discovery policy.

What only a person can write lives in `doc/`:

```
doc/
├── en.json, pt-BR.json, es.json   one per language, same structure
└── examples.json                  values to show per domain (language-independent)
```

```json
{
  "title": "…",
  "subtitle": "…",
  "sections": [{ "title": "…", "body": [ … ] }],
  "groups": [{ "id": "L1", "title": "…", "intro": [ … ], "domains": ["DOMAIN", "…"] }],
  "domains": { "DOMAIN": { "title": "…", "what": [ … ], "masking": [ … ] } },
  "closing": [{ "title": "…", "body": [ … ] }]
}
```

- `sections` come before the explanation of discovery and masking (purpose, legal context);
  `closing` after the data class chapters (design notes, limits, verification, sources). There is no
  section on using the policy in this tool: how to load it belongs in the tool's own documentation.
- Every data class of the policy must be in exactly one group and have `title`, `what` and `masking`, in
  every language, and have at least one example — the builder refuses otherwise.
- A body is a list of paragraphs. A string is a paragraph; `{ "list": [...] }`, `{ "note": "…" }`,
  `{ "tip": "…" }` and `{ "table": { "head": [...], "rows": [[...]] } }` are the other blocks.
  Inside text, `` `code` ``, `**bold**` and `*italic*` are recognized.

Build, with the app running (it masks the examples) and Google Chrome installed (it prints):

```bash
node presets/_doc/build.mjs <id>              # all languages
node presets/_doc/build.mjs <id> pt-BR        # one
```

`DLPX_URL` points at the app (default `http://localhost:3000`) and `CHROME` at another Chrome.
Rebuild the PDFs whenever `preset.json` or `doc/` changes. The layout follows the frameworks
guide in `docs/`; the shared wording and how each framework's configuration reads in prose are in
`_doc/text.mjs`.

## `preset.json`

```json
{
  "version": 1,
  "versionDate": "2026-10-01",
  "name":    { "en": "…", "pt-BR": "…", "es": "…" },
  "summary": { "en": "…", "pt-BR": "…", "es": "…" },

  "profileSet": {
    "name": "…",
    "description": "…",
    "threshold": 80,
    "classifiers": ["classifier name", "…"]
  },
  "packs": {
    "essential": { "description": "…", "domains": ["domain name", "…"] }
  },

  "classifiers": [
    { "name": "…", "framework": "PATH | TYPE | REGEX | LIST", "domain": "…", "description": "…", "config": {} }
  ],
  "domains": [
    { "name": "…", "algorithm": "…", "tokenization": "…" }
  ],
  "algorithms": [
    { "name": "…", "framework": "algorithm.plugin.…", "config": {}, "input": "sample value" }
  ],
  "files": ["file-name.txt"]
}
```

- **`version`** — bump it with every change or improvement. The settings tab shows it on the card,
  a policy loaded from an older version says a new one is available, and resetting applies it.
- **`versionDate`** — the day that version was built, written `YYYY-MM-DD`. It is what says how old
  a policy is, so bump it together with the version; the card and the cover of the PDF show it beside
  the version number. It is optional, so a preset that does not say still loads, but all fifteen
  that ship carry it. In a `build.mjs` it sits next to the version as `VERSION_DATE`.
- **`name.en`** is required; the other languages fall back to it.
- **`profileSet.name`** is what gets saved and sent to Delphix. The fifteen that ship name the
  country, the law (or its number) and the version: `CL - Ley 21.719 - v3`. The policy is found by
  the preset it came from, not by name, so a new version renames it and keeps its link to the engine.
- **`packs.essential`** — the data classes of the essential pack. Loading it brings those data classes, the
  classifiers that vote for them, the algorithms they reach through references and the files all
  of that reads; its `description`, when given, replaces the discovery policy's. Without it, the preset
  only loads as the extended pack, which is everything.
- **`profileSet.classifiers`** names classifiers from the `classifiers` list, and every
  classifier's `domain` must be one of the `domains`: what a policy leans on ships with it, the same
  rule the engine sync follows. A data class's `algorithm` and `tokenization` are plain names and may
  point at a plugin built-in (`dlpx-core:CM Digits`) instead of an algorithm listed here.
- **`config`** is exactly what the tool stores and sends to Delphix: the classifier and framework
  configurations as the engine defines them.
- **Files** go in `files/` and are listed in `files`. A configuration names one as
  `preset-file://<name>` — for a Secure Lookup, `{ "lookupFile": { "uri": "preset-file://names.txt" } }`;
  for a LIST classifier, `{ "file": "preset-file://names.txt" }`. Loading copies the file into the
  files folder and rewrites the reference to that copy, which is what sending to Delphix uploads.

A preset with a problem is still listed, with the problems spelled out and loading disabled. The
algorithms' framework classes are checked when loading, since only the plugin knows them.

## What loading does

Everything is written in one transaction, and each row is tagged with the preset it came from.

- A row already tagged with the preset is overwritten — including a classifier or set renamed
  since, which gets its name back. A saved algorithm's test input goes back to the preset's.
- A name held by something that **did not** come from this preset — something you made, an engine
  import, another preset — is a conflict. Loading lists the conflicts and asks before replacing
  them. Files are only a conflict the first time, when one with the same name and different
  content is already in the files folder.
- The link to a Delphix engine is kept, so sending the policy after a reset updates what is there.
- What the preset brought before and the chosen pack does not carry — the other pack's items, or
  items a newer version dropped — is removed, and so are its files. Something that did not come
  from the preset and still uses one of them keeps it: a saved algorithm of yours inside a chain, a
  data class another classifier votes for, a classifier in another policy. What stays loses the tag.

## Unloading

**Unload** removes every row tagged with the preset, by the same rule: what something else still
uses stays, untagged, and is named. A file goes when nothing here reads it any more and it still
holds what the preset ships — one you edited in the files tab stays. The engine is not touched:
what was sent to Delphix stays there.

## Region and the download package

`build.mjs` writes two optional fields into the manifest: `region` (one of `north-america`,
`central-america`, `caribbean`, `south-america`, `europe`, `africa`, `asia`, `oceania`) and
`country` (ISO 3166 alpha-2). The list in *Settings → Discovery Policies* is grouped by the first
and shows the flag of the second; a preset without them lands under *Other*.

`GET /api/presets/<id>/bundle` builds the download package (`preset-bundle.js`): the PDFs, the two
import scripts from [`_bundle/`](_bundle/) and every object written as a template for each API, with
tokens (`{{ALG:…}}`, `{{FILE:…}}`, `{{FW:…}}`…) that the script swaps for what only the target knows —
ids, upload addresses. The scripts know nothing of any preset; changing one changes every package.
`import.ps1` must keep to what Windows PowerShell 5.1 parses, and ships with a BOM and CRLF.
