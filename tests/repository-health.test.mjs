import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("package and documented toolchain metadata agree", async () => {
  const packageMetadata = JSON.parse(await read("package.json"));
  const lockMetadata = JSON.parse(await read("package-lock.json"));
  const hostingMetadata = JSON.parse(await read(".openai/hosting.json"));
  const nodeVersion = (await read(".nvmrc")).trim();

  assert.equal(packageMetadata.private, true);
  assert.equal(packageMetadata.license, "UNLICENSED");
  assert.equal(packageMetadata.engines.node, nodeVersion);
  assert.equal(packageMetadata.packageManager, `npm@${packageMetadata.engines.npm}`);
  assert.equal(lockMetadata.packages[""].license, packageMetadata.license);
  assert.deepEqual(lockMetadata.packages[""].engines, packageMetadata.engines);
  assert.equal(
    packageMetadata.repository.url,
    "git+https://github.com/MasteraSnackin/shade-route.git",
  );
  assert.equal(hostingMetadata.d1, null);
  assert.equal(packageMetadata.dependencies["drizzle-orm"], undefined);
  assert.equal(packageMetadata.devDependencies["drizzle-kit"], undefined);
  assert.equal(packageMetadata.scripts["db:generate"], undefined);
});

test("CI is least privilege and pins third-party actions to immutable revisions", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const actionUses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm)]
    .map((match) => match[1]);

  assert.match(workflow, /^permissions:\n\s+contents: read$/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.ok(actionUses.length > 0);
  for (const action of actionUses) {
    assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/);
  }
});

test("public repository guidance and templates are present", async () => {
  const requiredFiles = [
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "CODE_OF_CONDUCT.md",
    "DATA-LICENSING.md",
    "CHANGELOG.md",
    "RELEASE.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/data_model_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/dependabot.yml",
  ];

  for (const relativePath of requiredFiles) {
    const contents = await read(relativePath);
    assert.ok(contents.trim().length > 0, `${relativePath} is empty`);
  }
});

test("README contains real repository/API links and no setup placeholder", async () => {
  const readme = await read("README.md");
  const ignore = await read(".gitignore");

  assert.doesNotMatch(readme, /ADD_REPOSITORY_URL/);
  assert.match(readme, /git clone https:\/\/github\.com\/MasteraSnackin\/shade-route\.git/);
  assert.match(readme, /"coordinates": \[\[/);
  assert.match(readme, /https:\/\/github\.com\/MasteraSnackin\/shade-route\/issues/);
  assert.match(ignore, /^\/tsconfig\.tsbuildinfo$/m);
  assert.match(ignore, /^\/exports\/$/m);
});
