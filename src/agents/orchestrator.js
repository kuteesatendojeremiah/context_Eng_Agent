// ============================================================
// Claude Orchestrator
// Hub-and-spoke coordinator that manages the full pipeline:
// Intent → Retrieval → Synthesis → Plan → Delegate → Review
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { translateIntent } from "../pipeline/intent_translator.js";
import { retrieveKnowledge, synthesizeKnowledge } from "../pipeline/knowledge_retriever.js";
import { searchCodebase } from "../rag/indexer.js";
import { runAgent, applyCodeChanges } from "./sub_agents.js";
import { buildPreview } from "../pipeline/preview_builder.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Load project context from CLAUDE.md ──────────────────────────────────────
function loadProjectContext(repoPath) {
  const claudeMdPath = path.join(repoPath, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    return fs.readFileSync(claudeMdPath, "utf8");
  }

  // Generate a basic context from README if available
  const readmePath = path.join(repoPath, "README.md");
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, "utf8");
    return `# Project Context (from README)\n${readme.slice(0, 2000)}`;
  }

  return "# Project Context\nNo CLAUDE.md found. Operating with limited project context.";
}

// ── Orchestrator State Machine ────────────────────────────────────────────────
export class Orchestrator {
  constructor(repoPath, options = {}) {
    this.repoPath = repoPath || process.env.REPO_PATH || "./sample_repo";
    this.runtimeRoot = options.runtimeRoot || process.env.RUNTIME_ROOT || (process.env.VERCEL ? "/tmp/context-eng-agent" : process.cwd());
    this.projectContext = loadProjectContext(this.repoPath);
    this.sessionLog = [];
    this.totalTokens = 0;
  }

  log(phase, message, data = null) {
    const entry = { phase, message, timestamp: new Date().toISOString(), data };
    this.sessionLog.push(entry);
    console.log(`[${phase.toUpperCase()}] ${message}`);
  }

  // ── Main entry point ──────────────────────────────────────────────────────
  async run(userRequest) {
    console.log("\n" + "═".repeat(60));
    console.log("🤖 CONTEXT-ENGINEERED MULTI-AGENT SYSTEM");
    console.log("═".repeat(60));
    console.log(`📥 Request: ${userRequest}`);
    console.log("═".repeat(60) + "\n");

    const startTime = Date.now();
    const results = {};

    // ── PHASE 1: Intent Translation ─────────────────────────────────────────
    this.log("phase1", "Translating intent...");
    const taskSpec = await translateIntent(userRequest, this.projectContext);
    results.taskSpec = taskSpec;
    this.log("phase1", `Task: "${taskSpec.title}" | Complexity: ${taskSpec.complexity}`);

    // ── PHASE 2: External Knowledge Retrieval ───────────────────────────────
    this.log("phase2", "Retrieving external knowledge...");
    const retrievedDocs = await retrieveKnowledge(taskSpec.search_queries || [], taskSpec);
    results.retrievedDocs = retrievedDocs;

    // ── PHASE 3: Knowledge Synthesis ────────────────────────────────────────
    this.log("phase3", "Synthesizing knowledge...");
    const knowledgeSummary = await synthesizeKnowledge(retrievedDocs, taskSpec);
    results.knowledgeSummary = knowledgeSummary;

    const knowledgeText = this._formatKnowledge(knowledgeSummary);

    // ── PHASE 4: Repository Context Retrieval ───────────────────────────────
    this.log("phase4", "Retrieving relevant code from repository...");
    const codeQuery = `${taskSpec.title} ${taskSpec.requirements?.slice(0, 2).join(" ")}`;
    const codeSnippets = await searchCodebase(
      codeQuery,
      parseInt(process.env.TOP_K_RESULTS) || 5
    );
    results.codeSnippets = codeSnippets;
    this.log("phase4", `Retrieved ${codeSnippets.length} relevant code snippets`);

    // ── PHASE 5: Planning ────────────────────────────────────────────────────
    this.log("phase5", "Planning implementation...");
    const planResult = await runAgent(
      "planner",
      `Create a detailed implementation plan for:\n\n${JSON.stringify(taskSpec, null, 2)}`,
      {
        projectContext: this.projectContext,
        codeSnippets,
        knowledgeSummary: knowledgeText,
      }
    );
    results.plan = planResult;
    this.totalTokens += planResult.tokensUsed || 0;

    // ── PHASE 6: Task Delegation to Sub-Agents ───────────────────────────────
    this.log("phase6", "Delegating to specialist agents...");
    const agentResults = [];

    for (const step of taskSpec.steps || []) {
      const role = step.agent_role || "backend";
      const taskDescription = `
Step ${step.id}: ${step.description}
Files likely affected: ${step.files_likely_affected?.join(", ") || "TBD"}

Full task spec:
${taskSpec.summary}

Requirements:
${taskSpec.requirements?.join("\n") || ""}
      `.trim();

      const agentResult = await runAgent(role, taskDescription, {
        projectContext: this.projectContext,
        codeSnippets,
        knowledgeSummary: knowledgeText,
        planContext: planResult.result,
      });

      agentResults.push({ step, agentResult });
      this.totalTokens += agentResult.tokensUsed || 0;

      // Apply code changes to repo if auto-apply is enabled
      if (process.env.AUTO_APPLY_CHANGES === "true") {
        const changes = applyCodeChanges(agentResult, this.repoPath);
        agentResult.appliedChanges = changes;
      }
    }

    results.agentResults = agentResults;

    // ── PHASE 7: Code Review ─────────────────────────────────────────────────
    this.log("phase7", "Running code review...");
    const allGeneratedCode = agentResults
      .map((ar) => `### Step ${ar.step.id}: ${ar.step.description}\n${ar.agentResult.result}`)
      .join("\n\n---\n\n");

    const reviewResult = await runAgent(
      "reviewer",
      `Review the following code changes for the task: "${taskSpec.title}"\n\n${allGeneratedCode}`,
      { projectContext: this.projectContext }
    );
    results.review = reviewResult;
    this.totalTokens += reviewResult.tokensUsed || 0;

    // ── PHASE 8: Test Generation ─────────────────────────────────────────────
    this.log("phase8", "Generating tests...");
    const testResult = await runAgent(
      "tester",
      `Write tests for the following implementation:\n\nTask: ${taskSpec.title}\n\n${allGeneratedCode.slice(0, 4000)}`,
      {
        projectContext: this.projectContext,
        codeSnippets,
      }
    );
    results.tests = testResult;
    this.totalTokens += testResult.tokensUsed || 0;

    // ── PHASE 9: Live Preview Generation ────────────────────────────────────
    this.log("phase9", "Building live preview...");
    try {
      const previewHtml = await buildPreview(taskSpec, agentResults, reviewResult);
      results.previewHtml = previewHtml;

      // Save preview file
      const previewsDir = path.join(this.runtimeRoot, "previews");
      fs.mkdirSync(previewsDir, { recursive: true });
      const previewPath = path.join(previewsDir, `preview_${Date.now()}.html`);
      fs.writeFileSync(previewPath, previewHtml);
      results.previewPath = previewPath;
      this.log("phase9", `Preview saved: ${previewPath}`);
    } catch (e) {
      this.log("phase9", `Preview generation failed: ${e.message}`);
      results.previewHtml = null;
    }

    // ── Final Summary ────────────────────────────────────────────────────────
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    results.meta = {
      duration: `${duration}s`,
      totalTokens: this.totalTokens,
      agentsUsed: agentResults.length + 3, // planner + reviewer + tester
      stepsCompleted: agentResults.length,
    };
    results.phaseLogs = this.sessionLog;

    console.log("\n" + "═".repeat(60));
    console.log("✅ PIPELINE COMPLETE");
    console.log(`⏱  Duration: ${duration}s`);
    console.log(`🪙  Total tokens: ~${this.totalTokens}`);
    console.log(`🤖  Agents used: ${results.meta.agentsUsed}`);
    console.log("═".repeat(60) + "\n");

    return results;
  }

  _formatKnowledge(summary) {
    if (!summary) return "";
    const parts = [
      summary.executive_summary,
      summary.key_concepts?.length
        ? `Key Concepts:\n${summary.key_concepts.join("\n")}`
        : "",
      summary.implementation_guide?.length
        ? `Implementation Guide:\n${summary.implementation_guide.join("\n")}`
        : "",
      summary.pitfalls?.length
        ? `Pitfalls to Avoid:\n${summary.pitfalls.join("\n")}`
        : "",
    ].filter(Boolean);
    return parts.join("\n\n");
  }

  // ── Save session report ───────────────────────────────────────────────────
  saveReport(results, outputPath = "./agent_report.json") {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`📄 Report saved to: ${outputPath}`);
    return outputPath;
  }
}
