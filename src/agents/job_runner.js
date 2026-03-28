import fs from "fs";
import path from "path";
import archiver from "archiver";
import { Orchestrator } from "./orchestrator.js";
import { runAgent } from "./sub_agents.js";
import { translateIntent } from "../pipeline/intent_translator.js";
import { retrieveKnowledge, synthesizeKnowledge } from "../pipeline/knowledge_retriever.js";
import { searchCodebase, indexRepository } from "../rag/indexer.js";
import { buildPreview } from "../pipeline/preview_builder.js";

const MAX_AGENTIC_STEPS = parseInt(process.env.MAX_AGENTIC_STEPS || "3", 10);
const MAX_STEP_RETRIES = parseInt(process.env.MAX_STEP_RETRIES || "1", 10);

const processingJobs = new Set();

function nowIso() {
  return new Date().toISOString();
}

function sanitizePath(relativeFile) {
  const safe = (relativeFile || "").replace(/\\/g, "/").trim();
  const normalized = path.posix.normalize(safe).replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("..")) {
    return null;
  }
  return normalized;
}

function ensureDirs(runtimeRoot) {
  const jobsDir = path.join(runtimeRoot, "jobs");
  const generatedDir = path.join(runtimeRoot, "generated");
  const bundlesDir = path.join(runtimeRoot, "bundles");
  const previewsDir = path.join(runtimeRoot, "previews");
  const reportsDir = path.join(runtimeRoot, "reports");

  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.mkdirSync(bundlesDir, { recursive: true });
  fs.mkdirSync(previewsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  return { jobsDir, generatedDir, bundlesDir, previewsDir, reportsDir };
}

function jobFilePath(runtimeRoot, jobId) {
  const { jobsDir } = ensureDirs(runtimeRoot);
  return path.join(jobsDir, `${jobId}.json`);
}

function loadJob(runtimeRoot, jobId) {
  const filePath = jobFilePath(runtimeRoot, jobId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJob(runtimeRoot, job) {
  const filePath = jobFilePath(runtimeRoot, job.id);
  job.updatedAt = nowIso();
  fs.writeFileSync(filePath, JSON.stringify(job, null, 2));
}

function extractFileBlocks(text) {
  const blocks = [];
  if (!text) return blocks;

  const pattern = /```(?:\w+)?(?::([^\n]+))?\n([\s\S]*?)```|\/\/ FILE:\s*([^\n]+)\n([\s\S]*?)(?=\/\/ FILE:|$)/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const filePath = match[1] || match[3];
    const code = match[2] || match[4];
    if (!filePath || !code) continue;

    const safePath = sanitizePath(filePath);
    if (!safePath) continue;

    blocks.push({ filePath: safePath, code: code.trim() });
  }

  return blocks;
}

function materializeGeneratedProject(job, runtimeRoot) {
  const { generatedDir } = ensureDirs(runtimeRoot);
  const outDir = path.join(generatedDir, job.id);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];

  for (const item of job.results.agentResults || []) {
    const blocks = extractFileBlocks(item.agentResult?.result || "");

    if (blocks.length === 0) {
      const fallbackPath = path.join(outDir, `step-${item.step.id}-${item.agentResult.role}.txt`);
      fs.writeFileSync(fallbackPath, item.agentResult?.result || "");
      written.push(path.relative(outDir, fallbackPath));
      continue;
    }

    for (const block of blocks) {
      const fullPath = path.join(outDir, block.filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, block.code);
      written.push(block.filePath);
    }
  }

  const summary = [
    `# Generated Project`,
    "",
    `Task: ${job.task}`,
    `Job ID: ${job.id}`,
    `Generated: ${nowIso()}`,
    "",
    "## Files",
    ...(written.length ? written.map((f) => `- ${f}`) : ["- No structured files extracted"]) ,
    "",
    "## Notes",
    "This export contains code inferred from agent outputs.",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "README.generated.md"), summary);

  return { outDir, files: written };
}

function zipDirectory(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(zipPath));
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function formatKnowledge(summary) {
  if (!summary) return "";

  const parts = [
    summary.executive_summary,
    summary.key_concepts?.length ? `Key Concepts:\n${summary.key_concepts.join("\n")}` : "",
    summary.implementation_guide?.length ? `Implementation Guide:\n${summary.implementation_guide.join("\n")}` : "",
    summary.pitfalls?.length ? `Pitfalls to Avoid:\n${summary.pitfalls.join("\n")}` : "",
  ].filter(Boolean);

  return parts.join("\n\n");
}

function nextProgress(job) {
  const order = [
    "queued",
    "indexing",
    "intent",
    "knowledge",
    "synthesis",
    "code_context",
    "planning",
    "executing",
    "review",
    "tests",
    "preview",
    "packaging",
    "complete",
  ];

  const idx = Math.max(order.indexOf(job.phase), 0);
  return Math.round((idx / (order.length - 1)) * 100);
}

export function createJob(runtimeRoot, payload = {}) {
  ensureDirs(runtimeRoot);
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const repoDir = payload.repoPath || process.env.REPO_PATH || "./sample_repo";

  const job = {
    id,
    status: "running",
    phase: "queued",
    progress: 0,
    task: payload.task,
    repoDir,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    error: null,
    retries: {},
    currentStepIndex: 0,
    phaseLogs: [],
    results: {
      taskSpec: null,
      retrievedDocs: null,
      knowledgeSummary: null,
      codeSnippets: [],
      plan: null,
      agentResults: [],
      review: null,
      tests: null,
      previewPath: null,
      reportPath: null,
      bundlePath: null,
      generatedFiles: [],
      meta: null,
    },
  };

  saveJob(runtimeRoot, job);
  return job;
}

function logPhase(job, phase, message) {
  job.phaseLogs.push({ phase, message, timestamp: nowIso() });
}

function ensureIndexed(repoDir) {
  const indexBase = process.env.VERCEL ? "/tmp" : process.cwd();
  const indexPath = path.join(indexBase, ".code_index.json");
  if (fs.existsSync(indexPath)) {
    return { chunksIndexed: 0, indexPath, skipped: true };
  }
  return indexRepository(repoDir);
}

function looksValidStepOutput(resultText) {
  if (!resultText) return false;
  if (resultText.length < 120) return false;
  if (resultText.includes("```") || resultText.includes("function ") || resultText.includes("class ")) {
    return true;
  }
  return true;
}

async function processNextStep(job, runtimeRoot) {
  if (job.status !== "running") return job;

  const projectContext = (() => {
    const claudePath = path.join(job.repoDir, "CLAUDE.md");
    const readmePath = path.join(job.repoDir, "README.md");
    if (fs.existsSync(claudePath)) return fs.readFileSync(claudePath, "utf8");
    if (fs.existsSync(readmePath)) return fs.readFileSync(readmePath, "utf8").slice(0, 2000);
    return "# Project Context\nNo project context file found.";
  })();

  switch (job.phase) {
    case "queued": {
      logPhase(job, "phase0", "Preparing workspace...");
      job.phase = "indexing";
      break;
    }

    case "indexing": {
      logPhase(job, "phase1", "Indexing repository context...");
      await ensureIndexed(job.repoDir);
      job.phase = "intent";
      break;
    }

    case "intent": {
      logPhase(job, "phase2", "Understanding your request...");
      const taskSpec = await translateIntent(job.task, projectContext);
      const trimmedSteps = (taskSpec.steps || []).slice(0, MAX_AGENTIC_STEPS);
      job.results.taskSpec = {
        ...taskSpec,
        steps: trimmedSteps,
      };
      job.phase = "knowledge";
      break;
    }

    case "knowledge": {
      logPhase(job, "phase3", "Gathering relevant knowledge...");
      const searchQueries = job.results.taskSpec?.search_queries || [job.task];
      job.results.retrievedDocs = await retrieveKnowledge(searchQueries, job.results.taskSpec);
      job.phase = "synthesis";
      break;
    }

    case "synthesis": {
      logPhase(job, "phase4", "Synthesizing best approach...");
      job.results.knowledgeSummary = await synthesizeKnowledge(job.results.retrievedDocs, job.results.taskSpec);
      job.phase = "code_context";
      break;
    }

    case "code_context": {
      logPhase(job, "phase5", "Mapping your existing codebase...");
      const taskSpec = job.results.taskSpec || { title: "Task", requirements: [] };
      const codeQuery = `${taskSpec.title} ${(taskSpec.requirements || []).slice(0, 2).join(" ")}`;
      job.results.codeSnippets = await searchCodebase(codeQuery, parseInt(process.env.TOP_K_RESULTS || "5", 10));
      job.phase = "planning";
      break;
    }

    case "planning": {
      logPhase(job, "phase6", "Drafting implementation plan...");
      job.results.plan = await runAgent(
        "planner",
        `Create a detailed implementation plan for:\n\n${JSON.stringify(job.results.taskSpec, null, 2)}`,
        {
          projectContext,
          codeSnippets: job.results.codeSnippets,
          knowledgeSummary: formatKnowledge(job.results.knowledgeSummary),
        }
      );
      job.phase = "executing";
      break;
    }

    case "executing": {
      const steps = job.results.taskSpec?.steps || [];
      if (job.currentStepIndex >= steps.length) {
        job.phase = "review";
        break;
      }

      const step = steps[job.currentStepIndex];
      const retryKey = `step_${step.id}`;
      const retries = job.retries[retryKey] || 0;

      logPhase(job, "phase7", `Implementing step ${step.id}/${steps.length}...`);

      const prompt = `
Step ${step.id}: ${step.description}
Files likely affected: ${(step.files_likely_affected || []).join(", ") || "TBD"}

Task summary:
${job.results.taskSpec?.summary || ""}

Requirements:
${(job.results.taskSpec?.requirements || []).join("\n")}

Plan:
${job.results.plan?.result || ""}

Return concrete implementation code with file paths.
      `.trim();

      const agentResult = await runAgent(step.agent_role || "backend", prompt, {
        projectContext,
        codeSnippets: job.results.codeSnippets,
        knowledgeSummary: formatKnowledge(job.results.knowledgeSummary),
        planContext: job.results.plan?.result,
      });

      if (!looksValidStepOutput(agentResult.result) && retries < MAX_STEP_RETRIES) {
        job.retries[retryKey] = retries + 1;
        logPhase(job, "phase7", `Step ${step.id} output looked incomplete, retrying...`);
        break;
      }

      job.results.agentResults.push({ step, agentResult });
      job.currentStepIndex += 1;
      break;
    }

    case "review": {
      logPhase(job, "phase8", "Reviewing generated solution...");
      const allGeneratedCode = (job.results.agentResults || [])
        .map((ar) => `### Step ${ar.step.id}: ${ar.step.description}\n${ar.agentResult.result}`)
        .join("\n\n---\n\n");

      job.results.review = await runAgent(
        "reviewer",
        `Review the following code changes for the task: "${job.results.taskSpec?.title || "Task"}"\n\n${allGeneratedCode}`,
        { projectContext }
      );
      job.phase = "tests";
      break;
    }

    case "tests": {
      logPhase(job, "phase9", "Generating test suite...");
      const allGeneratedCode = (job.results.agentResults || [])
        .map((ar) => `### Step ${ar.step.id}: ${ar.step.description}\n${ar.agentResult.result}`)
        .join("\n\n---\n\n");

      job.results.tests = await runAgent(
        "tester",
        `Write tests for the following implementation:\n\nTask: ${job.results.taskSpec?.title || "Task"}\n\n${allGeneratedCode.slice(0, 4000)}`,
        {
          projectContext,
          codeSnippets: job.results.codeSnippets,
        }
      );
      job.phase = "preview";
      break;
    }

    case "preview": {
      const previewEnabled = process.env.ENABLE_PREVIEW === "true" || !process.env.VERCEL;
      if (!previewEnabled) {
        logPhase(job, "phase10", "Skipping preview generation for faster serverless execution...");
        job.results.previewPath = null;
        job.phase = "packaging";
        break;
      }

      logPhase(job, "phase10", "Building visual preview...");
      try {
        const previewHtml = await buildPreview(job.results.taskSpec, job.results.agentResults, job.results.review);
        const { previewsDir } = ensureDirs(runtimeRoot);
        const previewPath = path.join(previewsDir, `preview_${job.id}.html`);
        fs.writeFileSync(previewPath, previewHtml);
        job.results.previewPath = previewPath;
      } catch (err) {
        logPhase(job, "phase10", `Preview skipped: ${err.message}`);
        job.results.previewPath = null;
      }
      job.phase = "packaging";
      break;
    }

    case "packaging": {
      logPhase(job, "phase11", "Packaging downloadable project...");
      const packaged = materializeGeneratedProject(job, runtimeRoot);
      job.results.generatedFiles = packaged.files;

      const { bundlesDir, reportsDir } = ensureDirs(runtimeRoot);
      const zipPath = path.join(bundlesDir, `${job.id}.zip`);
      await zipDirectory(packaged.outDir, zipPath);
      job.results.bundlePath = zipPath;

      const reportPath = path.join(reportsDir, `report_${job.id}.json`);
      const reportData = {
        taskSpec: job.results.taskSpec,
        retrievedDocs: job.results.retrievedDocs,
        knowledgeSummary: job.results.knowledgeSummary,
        codeSnippets: job.results.codeSnippets,
        plan: job.results.plan,
        agentResults: job.results.agentResults,
        review: job.results.review,
        tests: job.results.tests,
        previewPath: job.results.previewPath,
        phaseLogs: job.phaseLogs,
      };
      fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
      job.results.reportPath = reportPath;

      const totalTokens = [
        job.results.plan?.tokensUsed || 0,
        ...(job.results.agentResults || []).map((r) => r.agentResult.tokensUsed || 0),
        job.results.review?.tokensUsed || 0,
        job.results.tests?.tokensUsed || 0,
      ].reduce((sum, n) => sum + n, 0);

      job.results.meta = {
        duration: `${Math.max(1, Math.round((Date.now() - new Date(job.createdAt).getTime()) / 1000))}s`,
        totalTokens,
        agentsUsed: (job.results.agentResults || []).length + 3,
        stepsCompleted: (job.results.agentResults || []).length,
      };

      job.phase = "complete";
      job.status = "complete";
      break;
    }

    default:
      break;
  }

  job.progress = nextProgress(job);
  return job;
}

export async function advanceJob(runtimeRoot, jobId) {
  const current = loadJob(runtimeRoot, jobId);
  if (!current) return null;

  if (current.status !== "running") {
    return current;
  }

  if (processingJobs.has(jobId)) {
    return current;
  }

  processingJobs.add(jobId);
  try {
    const updated = await processNextStep(current, runtimeRoot);
    saveJob(runtimeRoot, updated);
    return updated;
  } catch (err) {
    current.status = "failed";
    current.error = err.message;
    current.phase = "failed";
    current.progress = current.progress || 0;
    logPhase(current, "error", err.message);
    saveJob(runtimeRoot, current);
    return current;
  } finally {
    processingJobs.delete(jobId);
  }
}

export function getJob(runtimeRoot, jobId) {
  return loadJob(runtimeRoot, jobId);
}

export function getJobPublicView(job) {
  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    phaseLogs: job.phaseLogs,
    results: job.status === "complete"
      ? {
          title: job.results.taskSpec?.title,
          summary: job.results.taskSpec?.summary,
          steps: job.results.agentResults?.length || 0,
          meta: job.results.meta,
          reviewSummary: job.results.review?.result?.slice(0, 800),
          tests: job.results.tests?.result,
          previewPath: job.results.previewPath,
          hasPreview: !!job.results.previewPath,
          reportPath: job.results.reportPath,
          bundleReady: !!job.results.bundlePath,
          bundleUrl: `/api/download/${job.id}`,
          files: job.results.generatedFiles || [],
        }
      : null,
  };
}
