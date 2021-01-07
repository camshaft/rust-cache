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
const stateDepsHash = "RUST_DEPS_CACHE_HASH";
const stateLibHash = "RUST_LIB_CACHE_HASH";

const home = os.homedir();
export const paths = {
  index: path.join(home, ".cargo/registry/index"),
  cache: path.join(home, ".cargo/registry/cache"),
  git: path.join(home, ".cargo/git"),
  target: 'target'
};

interface CacheConfig {
  paths: Array<string>;
  key: string;
  restoreKeys: Array<string>;
  secondaryKeys: Array<string>;
}

const RefKey = "GITHUB_REF";

export function isValidEvent(): boolean {
  return RefKey in process.env && Boolean(process.env[RefKey]);
}

export async function getCacheConfig(): Promise<CacheConfig> {
  const depsHash = await getCachedHash(stateDepsHash, [
    '**/Cargo.toml',
    '**/Cargo.lock'
  ]);
  const libHash = await getCachedHash(stateLibHash, [
    '**/*.rs',
  ]);

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
    paths: [paths.index, paths.cache, paths.git, paths.target],
    key: `${key}-${depsHash}-${libHash}`,
    secondaryKeys: [`${key}-${libHash}-${depsHash}`],
    restoreKeys: [`${key}-${depsHash}`, `${key}-${libHash}`, key],
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

async function getCachedHash(key: string, patterns: string[]): Promise<string> {
  let hash = core.getState(key);
  if (!hash) {
    hash = await getHash(patterns);
    core.saveState(key, hash);
  }
  return hash;
}

async function getHash(patterns: string[]): Promise<string> {
  const globber = await glob.create(patterns.join('\n'), { followSymbolicLinks: false });
  const files = await globber.glob();
  files.sort((a, b) => a.localeCompare(b));

  const hasher = crypto.createHash("sha1");
  for (const file of files) {
    for await (const chunk of fs.createReadStream(file)) {
      hasher.update(chunk);
    }
  }
  return hasher.digest("base64").slice(0, 20);
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

export async function cleanTarget(packages: Packages) {
  await fs.promises.unlink("./target/.rustc_info.json");
  await io.rmRF("./target/debug/examples");
  await io.rmRF("./target/debug/incremental");

  let dir: fs.Dir;
  // remove all *files* from debug
  dir = await fs.promises.opendir("./target/debug");
  for await (const dirent of dir) {
    if (dirent.isFile()) {
      await rm(dir.path, dirent);
    }
  }

  const keepPkg = new Set(packages.map((p) => p.name));
  await rmExcept("./target/debug/build", keepPkg);
  await rmExcept("./target/debug/.fingerprint", keepPkg);

  const keepDeps = new Set(
    packages.flatMap((p) => {
      const names = [];
      for (const n of [p.name, ...p.targets]) {
        const name = n.replace(/-/g, "_");
        names.push(name, `lib${name}`);
      }
      return names;
    }),
  );
  await rmExcept("./target/debug/deps", keepDeps);
}

const oneWeek = 7 * 24 * 3600 * 1000;

export async function rmExcept(dirName: string, keepPrefix: Set<string>) {
  const dir = await fs.promises.opendir(dirName);
  for await (const dirent of dir) {
    let name = dirent.name;
    const idx = name.lastIndexOf("-");
    if (idx !== -1) {
      name = name.slice(0, idx);
    }
    const fileName = path.join(dir.path, dirent.name);
    const { mtime } = await fs.promises.stat(fileName);
    // we don’t really know
    if (!keepPrefix.has(name) || Date.now() - mtime.getTime() > oneWeek) {
      await rm(dir.path, dirent);
    }
  }
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
