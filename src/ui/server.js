// ============================================================
// Web UI Server
// A browser interface to interact with the multi-agent system
// Run: node src/ui/server.js
// ============================================================

import "dotenv/config";
import express from "express";
import { Orchestrator } from "../agents/orchestrator.js";
import { indexRepository } from "../rag/indexer.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.UI_PORT || 3000;
const RUNTIME_ROOT = process.env.VERCEL ? "/tmp/context-eng-agent" : process.cwd();
const REPORTS_DIR = path.join(RUNTIME_ROOT, "reports");
const PREVIEWS_DIR = path.join(RUNTIME_ROOT, "previews");

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "src/ui/public")));

// ── Run agent endpoint ────────────────────────────────────────────────────────
app.post("/api/run", async (req, res) => {
  const { task, repoPath } = req.body;

  if (!task) return res.status(400).json({ error: "Task is required" });

  try {
    const repoDir = repoPath || process.env.REPO_PATH || "./sample_repo";

    // Index if needed
    const indexBase = process.env.VERCEL ? "/tmp" : process.cwd();
    const indexPath = path.join(indexBase, ".code_index.json");
    if (!fs.existsSync(indexPath)) {
      await indexRepository(repoDir);
    }

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
    const orchestrator = new Orchestrator(repoDir, { runtimeRoot: RUNTIME_ROOT });
    const results = await orchestrator.run(task);

    const reportPath = path.join(REPORTS_DIR, `report_${Date.now()}.json`);
    orchestrator.saveReport(results, reportPath);

    res.json({
      status: "complete",
      results: {
        title: results.taskSpec?.title,
        steps: results.agentResults?.length,
        meta: results.meta,
        reviewSummary: results.review?.result?.slice(0, 800),
        agentOutputs: results.agentResults?.map((ar) => ({
          step: ar.step.id,
          role: ar.agentResult.role,
          description: ar.step.description,
          output: ar.agentResult.result,
        })),
        tests: results.tests?.result,
        reportPath,
        previewPath: results.previewPath || null,
        hasPreview: !!results.previewHtml,
        phaseLogs: results.phaseLogs || [],
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Index endpoint ────────────────────────────────────────────────────────────
app.post("/api/index", async (req, res) => {
  const { repoPath } = req.body;
  try {
    const result = await indexRepository(repoPath || "./sample_repo");
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reports endpoint ──────────────────────────────────────────────────────────
app.get("/api/reports", (req, res) => {
  if (!fs.existsSync(REPORTS_DIR)) return res.json([]);

  const files = fs.readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 10);

  const reports = files.map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), "utf8"));
    return { file: f, title: data.taskSpec?.title, meta: data.meta };
  });

  res.json(reports);
});

app.get("/api/reports/:file", (req, res) => {
  const filePath = path.join(REPORTS_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  res.json(JSON.parse(fs.readFileSync(filePath, "utf8")));
});

// ── Preview endpoints ─────────────────────────────────────────────────────────
app.get("/api/previews", (req, res) => {
  if (!fs.existsSync(PREVIEWS_DIR)) return res.json([]);
  const files = fs.readdirSync(PREVIEWS_DIR)
    .filter((f) => f.endsWith(".html"))
    .sort().reverse().slice(0, 20);
  res.json(files.map(f => ({ file: f, url: `/preview/${f}` })));
});

// Serve preview HTML files directly (rendered in iframe)
app.get("/preview/:file", (req, res) => {
  const filePath = path.join(PREVIEWS_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send("<h1>Preview not found</h1>");
  res.setHeader("Content-Type", "text/html");
  // Allow iframe embedding from same origin
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.send(fs.readFileSync(filePath, "utf8"));
});

// ── Root route ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "src/ui/public/index.html"));
});

const currentModulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModulePath) {
  app.listen(PORT, () => {
    console.log(`\n🌐 Web UI running at http://localhost:${PORT}`);
  });
}

export default app;
