# Research PDFs (PRIMARY knowledge source)

Place real agricultural research **PDF** files here, for example:

```text
research/
  cotton_water_stress.pdf
  tomato_late_blight.pdf
```

Then either:

1. Restart the server (auto-imports **new** PDFs only), or
2. Call `POST /api/ingest-research`

## Pipeline

```text
PDF → extract text → clean → chunk → Gemini extract → normalize → embed → Neo4j
```

## Rules

- PDFs already imported (matched by `ResearchPaper.fileName`) are **skipped**
- Do **not** invent titles, years, URLs, or findings
- Filename is always stored for provenance
- OpenAlex is only used when Neo4j PDF knowledge is insufficient

Do not put invented “seed notes” here. Only real research PDFs.
