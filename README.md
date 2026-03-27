# Context-Engineered Multi-Agent Code Assistant

> Based on: **"Context Engineering for Multi-Agent LLM Code Assistants"** (arXiv:2508.08322)

A full implementation of the multi-agent pipeline.

---

## Architecture

```
User Request
     │
     ▼
┌─────────────────┐
│ Intent Translator│  ← Claude Opus  ( GPT-5)
│  (Phase 1)       │
└────────┬────────┘
         │ Structured Task Spec
         ▼
┌─────────────────┐
│ Knowledge        │  ← Web Search API  (Elicit)
│ Retriever (Ph.2) │
└────────┬────────┘
         │ Retrieved Docs
         ▼
┌─────────────────┐
│ Knowledge        │  ← Claude Synthesis  (paper: NotebookLM)
│ Synthesizer(Ph.3)│
└────────┬────────┘
         │ Distilled Knowledge
         ▼
┌─────────────────┐
│ RAG Code Index   │  ← Local JSON Index  (paper: Zilliz/ChromaDB)
│  (Phase 4)       │
└────────┬────────┘
         │ Relevant Code Snippets
         ▼
┌─────────────────────────────────────────┐
│         Claude Orchestrator              │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌────────┐ │
│  │Planner│ │Front │ │Back  │ │DevOps  │ │
│  │ (Ph.5)│ │end   │ │end   │ │        │ │
│  │       │ │(Ph.6)│ │(Ph.6)│ │  (Ph.6)│ │
│  └──────┘ └──────┘ └──────┘ └────────┘ │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │  Reviewer    │  │     Tester       │ │
│  │  (Phase 7)   │  │    (Phase 8)     │ │
│  └──────────────┘  └──────────────────┘ │
└─────────────────────────────────────────┘
```

---

## Substitutions from Paper

| Paper Component | This Implementation | Reason |
|----------------|---------------------|--------|
| GPT-5 | Claude Opus | GPT-5 not widely available |
| Elicit | Claude + Web Search tool | Elicit has no public API |
| NotebookLM | Claude summarization | NotebookLM has no API |
| Zilliz / ChromaDB | Local JSON index | Removes need for running server |

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### 3. Set up your repository
Copy `CLAUDE.md.template` to your target repository as `CLAUDE.md` and fill it in:
```bash
cp CLAUDE.md.template /path/to/your/repo/CLAUDE.md
```
Then update `REPO_PATH` in your `.env`.

### 4. Index the repository
```bash
node src/rag/indexer.js
```
Or it will auto-index on first run.

---

## Usage

### CLI Mode
```bash
# Run with a task
node src/index.js "Add input validation to the registration form"

# Interactive mode (prompts for task)
node src/index.js
```

### Web UI Mode
```bash
node src/ui/server.js
# Open http://localhost:3000
```

---

## Project Structure

```
context-eng-agent/
├── src/
│   ├── index.js                      # CLI entry point
│   ├── pipeline/
│   │   ├── intent_translator.js      # Phase 1: Task spec generation
│   │   └── knowledge_retriever.js   # Phase 2+3: Retrieval & synthesis
│   ├── rag/
│   │   └── indexer.js               # Phase 4: Code indexing & search
│   ├── agents/
│   │   ├── sub_agents.js            # Agent role definitions & executor
│   │   └── orchestrator.js          # Main hub-and-spoke coordinator
│   └── ui/
│       ├── server.js                # Web UI Express server
│       └── public/index.html        # Browser interface
├── reports/                         # Auto-generated session reports
├── sample_repo/                     # Auto-created test repository
├── .code_index.json                 # Auto-generated code index
├── CLAUDE.md.template               # Template for target repos
├── .env.example                     # Environment config template
└── package.json
```

---

## How It Works (Paper Phases)

1. **Intent Translation** — Your vague request becomes a structured JSON spec with steps, file paths, and search queries
2. **Knowledge Retrieval** — Web search finds relevant docs, library guides, and best practices
3. **Knowledge Synthesis** — Retrieved docs distilled into actionable bullet points
4. **RAG Code Index** — Your codebase chunked by AST and indexed for semantic search
5. **Planning** — Planner agent creates a detailed implementation plan
6. **Delegation** — Each step assigned to the right specialist agent (frontend/backend/devops)
7. **Code Review** — Reviewer agent checks all outputs for bugs, security, style
8. **Test Generation** — Tester agent writes tests for the new code

---

## Output

Each run produces:
- **Console output** with phase-by-phase progress
- **JSON report** in `./reports/report_[timestamp].json` containing:
  - Task spec
  - Retrieved knowledge summary
  - All agent outputs (code)
  - Code review feedback
  - Generated tests
  - Token usage and timing

---

## Extending

### Add a new agent role
In `src/agents/sub_agents.js`, add to `AGENT_ROLES`:
```js
security: {
  name: "Security Auditor",
  emoji: "🔒",
  system: `You are a security expert. Review code for vulnerabilities...`
}
```

### Use a real vector DB
Replace `searchCodebase()` in `src/rag/indexer.js` with ChromaDB:
```bash
npm install chromadb
# Start ChromaDB: docker run -p 8000:8000 chromadb/chroma
```
Then update the indexer to use `ChromaClient`.

---

## Requirements

- Node.js 18+
- Anthropic API key (`ANTHROPIC_API_KEY`)
- ~100MB disk for dependencies
