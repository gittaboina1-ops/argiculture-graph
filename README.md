# Agricultural Knowledge Graph (Hackathon MVP)

Flow:

```text
Agricultural PDF → extract/chunk → Gemini → Neo4j (graph + vectors)
Farmer query → Neo4j semantic + graph → OpenAlex fallback if needed → Gemini answer → Cytoscape
```

## Install

```bash
npm install
```

## `.env`

```env
GEMINI_API_KEY=your_key
NEO4J_URI=neo4j+s://xxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password
PORT=3000
```

Optional:

```env
GEMINI_MODEL=gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.8-flash
EMBEDDING_MODEL=gemini-embedding-001
OPENALEX_API_KEY=your_openalex_key
```

## Add research PDFs (primary knowledge)

Put real PDFs in `research/`, then:

```bash
node server.js
```

Or after the server is running:

```bash
curl -X POST http://localhost:3000/api/ingest-research
```

Already-imported PDFs (by filename) are skipped.

## Start

```bash
node server.js
```

Open: **http://localhost:3000**

## Architecture

```text
Browser → POST /api/analyze → server.js
  → Semantic search (aliases + embeddings)
  → Neo4j vector search (PDF-derived knowledge first)
  → Neo4j graph traversal
  → OpenAlex / Europe PMC only if Neo4j evidence is insufficient
  → Gemini (extraction + final answer over retrieved evidence)
  → Cytoscape graph from Neo4j
```

Frontend never calls Gemini, Neo4j, or research APIs directly.
