import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { getCacheConfig, stateKey } from "./common";
import * as sccache from './sccache'

async function run() {
  try {
    core.exportVariable("CARGO_INCREMENTAL", 0);

    const { paths, key, restoreKeys } = await getCacheConfig();

    paths.push(...sccache.paths());

    core.info(`Restoring paths:\n    ${paths.join("\n    ")}`);
    core.info(`Using keys:\n    ${[key, ...restoreKeys].join("\n    ")}`);
    const restoreKey = await cache.restoreCache(paths, key, restoreKeys);
    if (restoreKey) {
      core.info(`Restored from cache key "${restoreKey}".`);
      core.saveState(stateKey, restoreKey);
    } else {
      core.info("No cache found.");
    }

    await sccache.restore();
  } catch (e) {
    core.info(`[warning] ${e.message}`);
  }
}

run();
