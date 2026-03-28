// ============================================================
// Web UI Server
// A browser interface to interact with the multi-agent system
// Run: node src/ui/server.js
// ============================================================

import "dotenv/config";
import express from "express";
import { indexRepository } from "../rag/indexer.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { advanceJob, createJob, getJob, getJobPublicView } from "../agents/job_runner.js";

const app = express();
const PORT = process.env.UI_PORT || 3000;
const RUNTIME_ROOT = process.env.VERCEL ? "/tmp/context-eng-agent" : process.cwd();
const REPORTS_DIR = path.join(RUNTIME_ROOT, "reports");
const PREVIEWS_DIR = path.join(RUNTIME_ROOT, "previews");

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "src/ui/public")));

// ── Run agent endpoint (job-based, timeout-safe) ─────────────────────────────
app.post("/api/run", async (req, res) => {
  const { task, repoPath } = req.body;

  if (!task) return res.status(400).json({ error: "Task is required" });

  try {
    const job = createJob(RUNTIME_ROOT, { task, repoPath });
    res.status(202).json({
      status: "accepted",
      jobId: job.id,
      pollUrl: `/api/job/${job.id}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/job/:id", async (req, res) => {
  try {
    const job = await advanceJob(RUNTIME_ROOT, req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(getJobPublicView(job));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download/:id", (req, res) => {
  const job = getJob(RUNTIME_ROOT, req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "complete") {
    return res.status(409).json({ error: "Job is not complete yet" });
  }

  const bundlePath = job.results?.bundlePath;
  if (!bundlePath || !fs.existsSync(bundlePath)) {
    return res.status(404).json({ error: "Download bundle not found" });
  }

  return res.download(bundlePath, `${job.id}.zip`);
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
    return { file: f, title: data.taskSpec?.title, meta: data.meta || null };
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
