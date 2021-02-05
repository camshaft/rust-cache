import * as core from "@actions/core";
import * as http from "@actions/http-client";
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache'
import os from "os";
import path from 'path';
import fs from 'fs';

const home = os.homedir();

export function config() {
  return {
    size: core.getInput('cache-size') || '300M',
    dir: core.getInput('cache-dir') || path.join(home, '.sccache'),
    enabled: core.getInput('wrapper') !== 'false',
    version: core.getInput('sccache-version') || 'latest',
  }
}

export function paths() {
  return [
    config().dir,
  ]
}

const targets = new Map([
  ['darwin-arm64', 'aarch64-apple-darwin'],
  ['linux-arm64', 'aarch64-unknown-linux-musl'],
  ['darwin-x64', 'x86_64-apple-darwin'],
  ['linux-x64', 'x86_64-unknown-linux-musl'],
  ['win32-x64', 'x86_64-pc-windows-msvc'],
]);

export async function restore() {
    const conf = config();

    const platform = `${os.platform()}-${process.arch}`;
    const target = targets.get(platform);
    if (!target) {
      core.setFailed(`missing architecture for ${platform}`);
      return;
    }
    const version = (conf.version === 'latest' ? await resolveVersion('sccache') : conf.version).replace(/^v/, '');

    let lib;
    try {
      lib = await install(target, version);
    } catch (err) {
      // sccache hasn't been consistent in their tag naming scheme
      // try adding the v before giving up
      lib = await install(target, `v${version}`);
    }

    if (!lib) return;

    process.env.SCCACHE_CACHE_SIZE = conf.size;
    process.env.SCCACHE_DIR = conf.dir;
    process.env.SCCACHE_IDLE_TIMEOUT = '0';

    core.exportVariable('SCCACHE_CACHE_SIZE', conf.size);
    core.exportVariable('SCCACHE_DIR', conf.dir);
    core.exportVariable("SCCACHE_IDLE_TIMEOUT", 0);

    await exec.exec(lib, ['--start-server']);

    if (conf.enabled) {
      core.exportVariable('RUSTC_WRAPPER', 'sccache');
    }
}

async function install(target: string, version: string): Promise<string> {
    const tcVersion = version.replace(/^v/, '');
    let cachedPath = await tc.find('sccache', tcVersion);

    if (!cachedPath) {
      const name = `sccache-${version}-${target}`;
      const url = `https://github.com/mozilla/sccache/releases/download/${version}/${name}.tar.gz`;
      core.info(`Installing sccache from ${url}`);

      const binPath = await tc.downloadTool(url);
      const extractedPath = await tc.extractTar(binPath);
      core.info(`Successfully extracted sccache to ${extractedPath}`);

      cachedPath = await tc.cacheDir(path.join(extractedPath, name), 'sccache', tcVersion);
    }

    core.info(`adding ${cachedPath} to the executable path`);

    core.addPath(cachedPath);

    const bin = path.join(cachedPath, 'sccache');

    // make sure it's actually executable
    await chmodx(bin);

    return bin;
}

export async function stop() {
    try {
      await exec.exec('sccache', ['--stop-server']);
    } catch (err) {
      // ignore
    }
}

export async function resolveVersion(crate: string): Promise<string> {
    const url = `https://crates.io/api/v1/crates/${crate}`;
    const client = new http.HttpClient(
        'rust-cache (https://github.com/camshaft/rust-cache)',
    );

    const resp: any = await client.getJson(url);
    if (resp.result == null) {
        throw new Error('Unable to fetch latest crate version');
    }

    return resp.result['crate']['newest_version'];
}

function chmodx(bin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.chmod(bin, 0o775, (err) => err ? reject(err) : resolve(void 0))
  });
}
