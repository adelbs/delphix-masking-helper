# Pre-configured profile sets

Each folder here is one profile set shipped with the tool, listed under
**Settings → Profile Sets**. Loading it creates the set and everything it leans on — its
classifiers, their domains, those domains' algorithms and the files they read — as one of two
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

Folders starting with `_` are not presets: `_doc/` holds the documentation builder they share.

The documentation button serves the PDF in the interface language, falling back to English and
then to whichever exists.

The app reads nothing else in the folder, so a preset can keep whatever produces it next to the
output. The four that ship share one layout: `build.mjs` generates `preset.json` and `files/` from
its own definitions and the raw lists in `source/`, and `verify.mjs` checks the result — reviewing
every classifier, profiling sample columns with the local evaluator in `classifiers/` and masking
sample values through the running app. Each folder's `README.md` explains the design of its set.

| Folder | Profile set |
|---|---|
| [`chile-ley-21719/`](chile-ley-21719/) | Chile — Ley 21.719 |
| [`mexico-lfpdppp/`](mexico-lfpdppp/) | Mexico — LFPDPPP (2025) |
| [`panama-ley-81/`](panama-ley-81/) | Panama — Ley 81 de 2019 |
| [`belize-dpa-2021/`](belize-dpa-2021/) | Belize — Data Protection Act, 2021 |

## Documentation

Every preset ships a PDF per language that lists everything in it and explains it. The PDF is for
anyone running a Delphix Masking Engine, with or without this tool: it describes the set in the
engine's own terms — profile set, classifiers and their frameworks, domains, algorithms, rule sets,
inventory, profiling and masking jobs — and names nothing of this tool, neither its screens nor its
scripts. The builder refuses text that does. The PDF is generated, and most of it comes from
`preset.json` itself, so it cannot drift from the set:

- the cover and contents, with the set's counts, version and threshold;
- how discovery and masking work, common to every preset;
- the essential and extended packs, with their counts and the essential domains, which are also
  marked in the domain table and chapters;
- a table of all domains, how each is found and which algorithm masks it;
- a chapter per domain group, and in it every domain: **what it is** and **how it is masked**
  (written), every classifier with its rules (generated — column-name alternatives, accepted
  types, value patterns, lists with sizes and first values), the tree of algorithms it uses
  (generated), and examples masked by the running app;
- appendices with every algorithm and its full configuration, every file, the column-name
  exclusion lists, and every classifier of the profile set.

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
  `closing` after the domain chapters (design notes, limits, verification, sources). There is no
  section on using the set in this tool: how to load it belongs in the tool's own documentation.
- Every domain of the set must be in exactly one group and have `title`, `what` and `masking`, in
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
  a set loaded from an older version says a new one is available, and resetting applies it.
- **`name.en`** is required; the other languages fall back to it.
- **`profileSet.name`** is what gets saved and sent to Delphix. The four that ship name the
  country, the law (or its number) and the version: `CL - Ley 21.719 - v3`. The set is found by
  the preset it came from, not by name, so a new version renames it and keeps its link to the engine.
- **`packs.essential`** — the domains of the essential pack. Loading it brings those domains, the
  classifiers that vote for them, the algorithms they reach through references and the files all
  of that reads; its `description`, when given, replaces the profile set's. Without it, the preset
  only loads as the extended pack, which is everything.
- **`profileSet.classifiers`** names classifiers from the `classifiers` list, and every
  classifier's `domain` must be one of the `domains`: what a set leans on ships with it, the same
  rule the engine sync follows. A domain's `algorithm` and `tokenization` are plain names and may
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
- The link to a Delphix engine is kept, so sending the set after a reset updates what is there.
- What the preset brought before and the chosen pack does not carry — the other pack's items, or
  items a newer version dropped — is removed, and so are its files. Something that did not come
  from the preset and still uses one of them keeps it: a saved algorithm of yours inside a chain, a
  domain another classifier votes for, a classifier in another set. What stays loses the tag.

## Unloading

**Unload** removes every row tagged with the preset, by the same rule: what something else still
uses stays, untagged, and is named. A file goes when nothing here reads it any more and it still
holds what the preset ships — one you edited in the files tab stays. The engine is not touched:
what was sent to Delphix stays there.
