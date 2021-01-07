import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as glob from "@actions/glob";
import * as io from "@actions/io";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

process.on("uncaughtException", (e) => {
  core.info(`[warning] ${e.message}`);
});

export const stateKey = "RUST_CACHE_KEY";
const stateHash = "RUST_CACHE_HASH";

const home = os.homedir();
export const paths = {
  index: path.join(home, ".cargo/registry/index"),
  cache: path.join(home, ".cargo/registry/cache"),
  git: path.join(home, ".cargo/git"),
};

interface CacheConfig {
  paths: Array<string>;
  key: string;
  restoreKeys: Array<string>;
}

const RefKey = "GITHUB_REF";

export function isValidEvent(): boolean {
  return RefKey in process.env && Boolean(process.env[RefKey]);
}

export async function getCacheConfig(): Promise<CacheConfig> {
  let lockHash = core.getState(stateHash);
  if (!lockHash) {
    lockHash = await getLockfileHash();
    core.saveState(stateHash, lockHash);
  }

  let key = `v0-camshaft-rust-cache-`;

  let inputKey = core.getInput("key");
  if (inputKey) {
    key += `${inputKey}-`;
  }

  const job = process.env.GITHUB_JOB;
  if (job) {
    key += `${job}-`;
  }

  key += await getRustKey();

  return {
    paths: [paths.index, paths.cache, paths.git],
    key: `${key}-${lockHash}`,
    restoreKeys: [key],
  };
}

async function getRustKey(): Promise<string> {
  const rustc = await getRustVersion();
  return `${rustc.release}-${rustc.host}-${rustc["commit-hash"].slice(0, 12)}`;
}

interface RustVersion {
  host: string;
  release: string;
  "commit-hash": string;
}

async function getRustVersion(): Promise<RustVersion> {
  const stdout = await getCmdOutput("rustc", ["-vV"]);
  let splits = stdout
    .split(/[\n\r]+/)
    .filter(Boolean)
    .map((s) => s.split(":").map((s) => s.trim()))
    .filter((s) => s.length === 2);
  return Object.fromEntries(splits);
}

export async function getCmdOutput(
  cmd: string,
  args: Array<string> = [],
  options: exec.ExecOptions = {},
): Promise<string> {
  let stdout = "";
  await exec.exec(cmd, args, {
    silent: true,
    listeners: {
      stdout(data) {
        stdout += data.toString();
      },
    },
    ...options,
  });
  return stdout;
}

async function getLockfileHash(): Promise<string> {
  const globber = await glob.create("**/Cargo.toml\n**/Cargo.lock", { followSymbolicLinks: false });
  const files = await globber.glob();
  files.sort((a, b) => a.localeCompare(b));

  const hasher = crypto.createHash("sha1");
  for (const file of files) {
    for await (const chunk of fs.createReadStream(file)) {
      hasher.update(chunk);
    }
  }
  return hasher.digest("hex").slice(0, 20);
}

export interface PackageDefinition {
  name: string;
  version: string;
  path: string;
  targets: Array<string>;
}

export type Packages = Array<PackageDefinition>;

interface Meta {
  packages: Array<{
    name: string;
    version: string;
    manifest_path: string;
    targets: Array<{ kind: Array<string>; name: string }>;
  }>;
}

export async function getPackages(): Promise<Packages> {
  const cwd = process.cwd();
  const meta: Meta = JSON.parse(await getCmdOutput("cargo", ["metadata", "--all-features", "--format-version", "1"]));

  return meta.packages
    .filter((p) => !p.manifest_path.startsWith(cwd))
    .map((p) => {
      const targets = p.targets.filter((t) => t.kind[0] === "lib").map((t) => t.name);
      return { name: p.name, version: p.version, targets, path: path.dirname(p.manifest_path) };
    });
}

export async function rm(parent: string, dirent: fs.Dirent) {
  try {
    const fileName = path.join(parent, dirent.name);
    core.debug(`deleting "${fileName}"`);
    if (dirent.isFile()) {
      await fs.promises.unlink(fileName);
    } else if (dirent.isDirectory()) {
      await io.rmRF(fileName);
    }
  } catch {}
}
