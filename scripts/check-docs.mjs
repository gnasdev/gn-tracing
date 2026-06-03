import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const docsDir = path.join(root, "docs");
const markdownFiles = [];
const diagnostics = [];

function addDiagnostic(filePath, line, message) {
  const location = `${path.relative(root, filePath)}:${line}`;
  diagnostics.push(`${location} ${message}`);
}

function getLineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(entryPath);
      continue;
    }

    if (entry.name.endsWith(".md")) {
      markdownFiles.push(entryPath);
    }
  }
}

function parseMarkdownTarget(rawTarget) {
  let target = rawTarget.trim();
  if (!target || /^(https?:|mailto:|file:|#)/i.test(target)) {
    return null;
  }

  if (target.startsWith("<")) {
    const end = target.indexOf(">");
    target = end === -1 ? target.slice(1) : target.slice(1, end);
  } else {
    target = target.split(/\s+/)[0];
  }

  if (!target.toLowerCase().includes(".md")) {
    return null;
  }

  const pathOnly = target.split("#")[0];
  if (!pathOnly) {
    return null;
  }

  try {
    return decodeURI(pathOnly);
  } catch {
    return pathOnly;
  }
}

function checkWhitespace(filePath, text) {
  if (text.includes("\r")) {
    addDiagnostic(filePath, 1, "uses CRLF or CR line endings; expected LF.");
  }

  if (!text.endsWith("\n")) {
    addDiagnostic(filePath, text.split("\n").length, "is missing a final newline.");
  }

  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      addDiagnostic(filePath, index + 1, "has trailing whitespace.");
    }
  });
}

function checkMarkdownLinks(filePath, text) {
  const markdownLinkPattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  for (const match of text.matchAll(markdownLinkPattern)) {
    checkTarget(filePath, text, match.index, match[1]);
  }

  const relatedLinkPattern = /^\s*-\s+["']?((?:\.\.?\/)[^"'\n]+\.md(?:#[^"'\n]+)?)["']?\s*$/gm;
  for (const match of text.matchAll(relatedLinkPattern)) {
    checkTarget(filePath, text, match.index, match[1]);
  }
}

function checkTarget(filePath, text, index, rawTarget) {
  const target = parseMarkdownTarget(rawTarget);
  if (!target) {
    return;
  }

  const resolved = path.resolve(path.dirname(filePath), target);
  if (!fs.existsSync(resolved)) {
    addDiagnostic(
      filePath,
      getLineNumber(text, index),
      `links to missing markdown file: ${rawTarget.trim()}`,
    );
  }
}

if (!fs.existsSync(docsDir)) {
  console.error("Docs check failed: docs/ directory is missing.");
  process.exit(1);
}

walk(docsDir);

for (const filePath of markdownFiles) {
  const text = fs.readFileSync(filePath, "utf8");
  checkWhitespace(filePath, text);
  checkMarkdownLinks(filePath, text);
}

if (diagnostics.length > 0) {
  console.error("Docs check failed:");
  for (const diagnostic of diagnostics) {
    console.error(`- ${diagnostic}`);
  }
  process.exit(1);
}

console.log(`Docs check passed (${markdownFiles.length} Markdown files).`);
