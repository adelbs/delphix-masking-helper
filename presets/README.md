# Pre-configured profile sets

Each folder here is one profile set shipped with the tool, listed under
**Settings → Profile Sets**. Loading it creates the set and everything it leans on — its
classifiers, their domains, those domains' algorithms and the files they read. Loading it again
is a **reset**: the same rows are found and put back the way they ship, never duplicated.

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
output — `chile-ley-21719/` has a generator and a verification script.

## Documentation

Every preset ships a PDF per language that lists everything in it and explains it. The PDF is
generated, and most of it comes from `preset.json` itself, so it cannot drift from the set:

- the cover and contents, with the set's counts, version and threshold;
- how discovery and masking work, common to every preset;
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

- `sections` come before the explanation of discovery and masking (purpose, legal context, how to
  use the set); `closing` after the domain chapters (design notes, limits, verification, sources).
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

- **`version`** — bump it when the content changes. A set loaded from an older version says a new
  one is available; resetting applies it.
- **`name.en`** is required; the other languages fall back to it.
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
- A row an older version shipped and the current one does not is left in place, no longer tagged.
