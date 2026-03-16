# Smart Resume Builder

LLM-powered resume tailoring pipeline. One task file → tailored HTML, PDF, and DOCX outputs scored against the job ad.

## Setup

```bash
npm install
cp .env.example .env   # add GITHUB_TOKEN (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
```

## Run

```bash
npm run task -- inputs/tasks/my_task.json
# or shorthand:
npm run task:1
npm run task:2
```

Outputs land in the directory set by `outputDir` in the task file:

```
PeterHo_Resume_elegant.html/pdf/docx         ← named theme renders
PeterHo_Resume_<template>_dtpl.docx          ← DOCX template render (docxtemplater)
tailored_resume.json                         ← raw tailored JSON Resume
score.json                                   ← ATS match score and missing keywords
```

---

## Task file

Create `inputs/tasks/my_task.json`:

```jsonc
{
  "description": "Senior Fullstack Engineer",

  "baseResume": "base-resume.json",
  "jobAd":      "inputs/job_ads/revel_street.txt",
  "outputDir":  "outputs/my_job",
  "mode":       "llm",

  // Pick a render target (both are optional; defaults to elegant theme):
  "theme":       "elegant",                                         // named JSON Resume theme
  "templateDocx": "inputs/resume_templates/resume_template_2.docx", // LLM-analysed DOCX template

  "llm": {
    "provider": "github-copilot"   // key from config/llm_providers.json

    // Optional per-task overrides:
    // "model":       "gpt-4.1",
    // "temperature": 0.2,
    // "promptFile":  "config/llm-prompt.md"
  }
}
```

### Fields

| Field             | Required    | Description                                                                  |
| ----------------- | ----------- | ---------------------------------------------------------------------------- |
| `baseResume`      | yes         | Path to your master JSON Resume (relative to project root)                   |
| `jobAd`           | yes         | Path to a job ad `.txt` file, an array of paths, or `"all"`                  |
| `outputDir`       | yes         | Output directory (created if missing)                                        |
| `mode`            | yes         | `"llm"` or `"programmatic"` (keyword matching, no LLM call)                  |
| `theme`           | no          | Named [JSON Resume theme](https://jsonresume.org/themes/) — e.g. `"elegant"` |
| `templateDocx`    | no          | Path to a `.docx` template — analysed by LLM and rendered with docxtemplater |
| `templateDocxTpl` | no          | Path to a pre-built `_tpl.docx` — skips analysis, goes straight to render    |
| `llm.provider`    | if mode=llm | Provider key defined in `config/llm_providers.json`                          |

---

## Job ads

```jsonc
// Single file
"jobAd": "inputs/job_ads/revel_street.txt"

// Multiple files
"jobAd": ["inputs/job_ads/job_a.txt", "inputs/job_ads/job_b.txt"]

// All files in inputs/job_ads/
"jobAd": "all"
```

---

## DOCX templates

Drop `.docx` files in `inputs/resume_templates/` and reference one in the task:

```jsonc
"templateDocx": "inputs/resume_templates/resume_template_2.docx"
```

### How it works

1. **Analysis** — The LLM reads the DOCX structure (sections, table layout, fonts) and produces a mapping JSON describing how to match JSON Resume fields to template placeholders.
2. **Human-in-the-loop review** — An interactive terminal prompt lets you verify and correct the LLM's guesses before the template is built (see below).
3. **Template build** — Placeholders are injected into a copy of the DOCX (`_tpl.docx`) using docxtemplater-compatible tags.
4. **Render** — The tailored resume data is merged into the template producing the final `_dtpl.docx`.

Caches are stored in:

```
outputs/llm_docx_analysis/<template>_mapping.json   ← LLM mapping (edit freely)
outputs/templates/<template>_tpl.docx               ← built template (auto-rebuilt when missing)
```

Delete either file to force a rebuild on the next run.

### CLI flags

```bash
# Force re-analysis + rebuild even if caches exist, with interactive review
npm run task:2 -- --analyze

# Force re-analysis but skip interactive review (uses patched mapping as-is)
npm run task:2 -- --analyze --no-review
```

| Flag          | Effect                                                                            |
| ------------- | --------------------------------------------------------------------------------- |
| `--analyze`   | Re-runs LLM analysis and rebuilds the `_tpl.docx` even if cached files exist      |
| `--no-review` | Skips the interactive review step (useful for CI or re-runs on a trusted mapping) |

### Human-in-the-loop review

When `--analyze` runs (and `--no-review` is not set) the pipeline pauses for review in three stages:

**1. Section assignments** — confirm which JSON Resume array each section maps to:

```
  SECTION ASSIGNMENTS  (LLM identified section → JSON array)
  Valid values: work / projects / education / volunteer / ...

  [1]  "RELEVANT EXPERIENCE"  →  work
       Press Enter to accept, or type replacement: projects
       ✎  work  →  projects
```

**2. Item field mapping** — every body field in a section is shown for confirmation. The LLM often generates plausible-but-wrong mappings (e.g. `path("technologies")` when the value actually lives inside a highlights bullet). Pressing Enter keeps the current mapping, or auto-fixes it if it looks wrong:

```
  ITEM FIELD MAPPING: "RELEVANT EXPERIENCE" → projects
  Confirm how each body field maps to resume data.
  Options:  <fieldName>  |  prefix:<text>  |  Enter = keep current

  [?]  "Responsibilities: {description}"  currently=path("description")  → suggest: prefix:Responsibilities:
       Press Enter to keep, or type replacement:
       ✓  "description" kept: path("description")

  [?]  "Technology Stacks: {technologies}"  currently=path("technologies")  → suggest: prefix:Technology Stacks:
       Press Enter to keep, or type replacement:
       ✎  "technologies" → extractPrefix("Technology Stacks:") (auto-fixed)
```

- **Enter** — keeps the current mapping, but if it looks wrong (e.g. `path("technologies")` where a prefix exists) it is **auto-fixed** to `extractPrefix` automatically
- Type a **plain field name** (`summary`, `url`, `role`) → reads that field directly from the JSON Resume item  
- Type `prefix:<text>` → manually extract a highlights bullet starting with `<text>`

**3. Simple replacements** — review header/contact field mappings line by line, edit any by number.

---

## LLM providers

Provider definitions live in `config/llm_providers.json`.

```jsonc
{
  "defaultProvider": "github-copilot",
  "providers": {
    "github-copilot": {
      "model": "gpt-4.1",
      "apiKeyEnv": "GITHUB_TOKEN",
      "baseUrl": "https://models.inference.ai.azure.com",
      "maxTokens": 16384,
      "temperature": 0.3
    },
    "openai": {
      "model": "gpt-4o",
      "apiKeyEnv": "OPENAI_API_KEY",
      "baseUrl": "https://api.openai.com/v1",
      "maxTokens": 16384,
      "temperature": 0.3
    },
    "anthropic": {
      "model": "claude-sonnet-4-20250514",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "baseUrl": "https://api.anthropic.com/v1",
      "maxTokens": 16384,
      "temperature": 0.3
    }
  }
}
```

To switch providers for one task, set `llm.provider`. To override a single field without touching the global config:

```jsonc
"llm": {
  "provider": "openai",
  "model": "gpt-4.1"
}
```

---

## CLI overrides

```bash
# Override provider or model at the command line
npm run task -- inputs/tasks/task_1.json --provider anthropic --model claude-opus-4-5
```

---

## Outputs

| File                                  | Description                                       |
| ------------------------------------- | ------------------------------------------------- |
| `PeterHo_Resume_<theme>.html`         | Rendered HTML                                     |
| `PeterHo_Resume_<theme>.pdf`          | PDF (via Puppeteer)                               |
| `PeterHo_Resume_<theme>.docx`         | DOCX (JSON Resume theme layout)                   |
| `PeterHo_Resume_<template>_dtpl.docx` | DOCX rendered into the specified `.docx` template |
| `tailored_resume.json`                | Raw tailored JSON Resume                          |
| `score.json`                          | ATS match score and missing keywords              |


LLM-powered resume tailoring pipeline. One task file → tailored HTML, PDF, and DOCX outputs scored against the job ad.

## Setup

```bash
npm install
cp .env.example .env   # add GITHUB_TOKEN (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
```

## Run

```bash
npm run task -- inputs/tasks/my_task.json
# or shorthand:
npm run task:1
npm run task:2
```

Outputs land in the directory set by `outputDir` in the task file, named:

```
PeterHo_Resume.html/pdf/docx            ← default elegant theme
PeterHo_Resume_elegant.html/pdf/docx    ← named theme
PeterHo_Resume_resume_template_2.docx   ← DOCX template render
```

---

## Task file

Create `inputs/tasks/my_task.json`:

```jsonc
{
  "description": "Senior Fullstack Engineer",

  "baseResume":  "base-resume.json",
  "jobAd":       "inputs/job_ads/revel_street.txt",
  "outputDir":   "outputs/my_job",
  "mode":        "llm",

  // Optional — pick one:
  "theme":        "elegant",                                    // named JSON Resume theme
  "templateDocx": "inputs/resume_templates/resume_template_2.docx", // LLM-analysed DOCX template

  "llm": {
    "provider": "github-copilot"   // key from config/llm_providers.json

    // Optional per-task overrides:
    // "model":       "gpt-4.1",
    // "temperature": 0.2,
    // "promptFile":  "config/llm-prompt.md"
  }
}
```

### Fields

| Field          | Required    | Description                                                                            |
| -------------- | ----------- | -------------------------------------------------------------------------------------- |
| `baseResume`   | yes         | Path to your master JSON Resume (relative to project root)                             |
| `jobAd`        | yes         | Path to the job ad `.txt` file                                                         |
| `outputDir`    | yes         | Output directory (created if missing)                                                  |
| `mode`         | yes         | `"llm"` (LLM tailoring) or `"programmatic"` (keyword matching)                         |
| `theme`        | no          | Named [JSON Resume theme](https://jsonresume.org/themes/) — e.g. `"elegant"`, `"even"` |
| `templateDocx` | no          | Path to a `.docx` template — pipeline analyses its layout and renders into it          |
| `llm.provider` | if mode=llm | Provider key defined in `config/llm_providers.json`                                    |

> `theme` and `templateDocx` are both optional; if neither is set the default elegant theme is used for HTML/PDF, and no template DOCX is produced.

---

## Job ads

Drop `.txt` files in `inputs/job_ads/` and reference them in the task:

```jsonc
"jobAd": "inputs/job_ads/my_company.txt"
```

Pass multiple job ads:

```jsonc
"jobAd": ["inputs/job_ads/job_a.txt", "inputs/job_ads/job_b.txt"]
```

Process every file in `inputs/job_ads/`:

```jsonc
"jobAd": "all"
```

---

## DOCX templates

Drop `.docx` files in `inputs/resume_templates/` and reference one in the task:

```jsonc
"templateDocx": "inputs/resume_templates/resume_template_2.docx"
```

The pipeline uses the LLM to analyse the template's layout (header columns, section order, font sizes) and renders your tailored resume into it. The analysis is cached in `outputs/llm_docx_analysis/` — delete the cache file to force a re-analysis.

---

## LLM providers

Provider definitions live in `config/llm_providers.json` — edit once, reference by name in any task.

```jsonc
// config/llm_providers.json
{
  "defaultProvider": "github-copilot",
  "promptFile": "config/llm-prompt.md",
  "providers": {
    "github-copilot": {
      "model": "gpt-4o",
      "apiKeyEnv": "GITHUB_TOKEN",
      "baseUrl": "https://models.inference.ai.azure.com",
      "maxTokens": 4096,
      "temperature": 0.3
    },
    "openai": { ... },
    "anthropic": { ... }
  }
}
```

To switch providers for one task, change `llm.provider`. To override a single field (e.g. try a newer model) without touching the global config:

```jsonc
"llm": {
  "provider": "openai",
  "model": "gpt-4.1"
}
```

---

## CLI overrides

```bash
# Override provider or model without editing the task file
npm run task -- inputs/tasks/task_1.json --provider anthropic --model claude-opus-4-5
```

---

## Outputs

| File                             | Description                                       |
| -------------------------------- | ------------------------------------------------- |
| `PeterHo_Resume.html`            | Rendered HTML (default theme)                     |
| `PeterHo_Resume.pdf`             | PDF (requires Puppeteer)                          |
| `PeterHo_Resume.docx`            | DOCX (default elegant layout)                     |
| `PeterHo_Resume_<template>.docx` | DOCX rendered into the specified `.docx` template |
| `tailored_resume.json`           | Raw tailored JSON Resume                          |
| `score.json`                     | ATS match score and missing keywords              |

