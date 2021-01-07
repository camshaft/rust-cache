import * as core from "@actions/core";
import * as http from "@actions/http-client";
import * as exec from '@actions/exec';
import * as tc from '@actions/tool-cache'
import os from "os";
import path from 'path';

const home = os.homedir();

export function config() {
  return {
    size: core.getInput('sccache_size') || '300M',
    dir: core.getInput('sccache_dir') || path.join(home, '.sccache'),
    enabled: core.getInput('sccache_enabled') !== 'false',
    version: core.getInput('sccache_version') || 'latest',
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
    const version = conf.version === 'latest' ? await resolveVersion('sccache') : conf.version;

    const name = `sccache-${version}-${target}`;
    const url = `https://github.com/mozilla/sccache/releases/download/${version}/${name}.tar.gz`;
    core.info(`Installing sccache from ${url}`);

    const binPath = await tc.downloadTool(url);
    const extractedPath = await tc.extractTar(binPath);
    core.info(`Successfully extracted sccache to ${extractedPath}`);
    const cachedPath = await tc.cacheDir(path.join(extractedPath, name), 'sccache', version);
    core.addPath(cachedPath);

    process.env.SCCACHE_CACHE_SIZE = conf.size;
    process.env.SCCACHE_DIR = conf.dir;
    process.env.SCCACHE_IDLE_TIMEOUT = '0';

    core.exportVariable('SCCACHE_CACHE_SIZE', conf.size);
    core.exportVariable('SCCACHE_DIR', conf.dir);
    core.exportVariable("SCCACHE_IDLE_TIMEOUT", 0);

    await exec.exec('sccache', ['--start-server']);

    if (conf.enabled) {
      core.exportVariable('RUSTC_WRAPPER', 'sccache');
    }
}

export async function stop() {
    await exec.exec('sccache', ['--stop-server'])
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
