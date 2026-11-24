import fs from "node:fs";
import path from "node:path";
import type { PromptTemplate, PromptVersion } from "./types";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");

function readTemplateFile(filePath: string): PromptTemplate {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as PromptTemplate;
}

export function loadPromptTemplate(
  version: PromptVersion,
  filename: string
): PromptTemplate {
  const folder = version.toLowerCase();
  const fullPath = path.join(PROMPTS_DIR, folder, filename);
  return readTemplateFile(fullPath);
}

export function loadV3Stages(): PromptTemplate[] {
  const v3Dir = path.join(PROMPTS_DIR, "v3");
  const files = fs
    .readdirSync(v3Dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) => readTemplateFile(path.join(v3Dir, f)));
}

export function listAllPromptTemplates(): PromptTemplate[] {
  return [
    loadPromptTemplate("V1", "verify.json"),
    loadPromptTemplate("V2", "verify.json"),
    ...loadV3Stages(),
  ];
}

export function renderPromptTemplate(
  template: string,
  variables: Record<string, string>
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}
