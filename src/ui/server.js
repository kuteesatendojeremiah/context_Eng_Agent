// ============================================================
// Web UI Server
// A browser interface to interact with the multi-agent system
// Run: node src/ui/server.js
// ============================================================

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Orchestrator } from "../agents/orchestrator.js";
import { indexRepository } from "../rag/indexer.js";
import fs from "fs";
import path from "path";

const app = express();
const server = createServer(app);
const PORT = process.env.UI_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "src/ui/public")));

// ── SSE endpoint for streaming progress ──────────────────────────────────────
const activeStreams = new Map();

app.get("/api/stream/:sessionId", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  activeStreams.set(req.params.sessionId, res);
  req.on("close", () => activeStreams.delete(req.params.sessionId));
});

function sendEvent(sessionId, event, data) {
  const stream = activeStreams.get(sessionId);
  if (stream) {
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// ── Run agent endpoint ────────────────────────────────────────────────────────
app.post("/api/run", async (req, res) => {
  const { task, repoPath, sessionId } = req.body;

  if (!task) return res.status(400).json({ error: "Task is required" });

  res.json({ status: "started", sessionId });

  // Run async
  (async () => {
    try {
      sendEvent(sessionId, "phase", { phase: "starting", message: "Initializing pipeline..." });

      const repoDir = repoPath || process.env.REPO_PATH || "./sample_repo";

      // Index if needed
      const indexPath = path.join(process.cwd(), ".code_index.json");
      if (!fs.existsSync(indexPath)) {
        sendEvent(sessionId, "phase", { phase: "indexing", message: "Indexing repository..." });
        await indexRepository(repoDir);
      }

      const orchestrator = new Orchestrator(repoDir);

      // Monkey-patch log to stream events
      const origLog = orchestrator.log.bind(orchestrator);
      orchestrator.log = (phase, message, data) => {
        origLog(phase, message, data);
        sendEvent(sessionId, "phase", { phase, message });
      };

      const results = await orchestrator.run(task);

      // Save report
      fs.mkdirSync("./reports", { recursive: true });
      const reportPath = `./reports/report_${Date.now()}.json`;
      orchestrator.saveReport(results, reportPath);

      sendEvent(sessionId, "complete", {
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
        },
      });
    } catch (err) {
      sendEvent(sessionId, "error", { message: err.message });
    }
  })();
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
  const reportsDir = "./reports";
  if (!fs.existsSync(reportsDir)) return res.json([]);

  const files = fs.readdirSync(reportsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 10);

  const reports = files.map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(reportsDir, f), "utf8"));
    return { file: f, title: data.taskSpec?.title, meta: data.meta };
  });

  res.json(reports);
});

app.get("/api/reports/:file", (req, res) => {
  const filePath = path.join("./reports", req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  res.json(JSON.parse(fs.readFileSync(filePath, "utf8")));
});

// ── Preview endpoints ─────────────────────────────────────────────────────────
app.get("/api/previews", (req, res) => {
  const previewsDir = "./previews";
  if (!fs.existsSync(previewsDir)) return res.json([]);
  const files = fs.readdirSync(previewsDir)
    .filter((f) => f.endsWith(".html"))
    .sort().reverse().slice(0, 20);
  res.json(files.map(f => ({ file: f, url: `/preview/${f}` })));
});

// Serve preview HTML files directly (rendered in iframe)
app.get("/preview/:file", (req, res) => {
  const filePath = path.join("./previews", req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send("<h1>Preview not found</h1>");
  res.setHeader("Content-Type", "text/html");
  // Allow iframe embedding from same origin
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.send(fs.readFileSync(filePath, "utf8"));
});

// ── Root route ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("<h1>Context-Eng Agent is running 🚀</h1>");
});

server.listen(PORT, () => {
  console.log(`\n🌐 Web UI running at http://localhost:${PORT}`);
});
