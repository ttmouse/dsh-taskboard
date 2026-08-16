import os from "node:os";
import { pathToFileURL } from "node:url";

import { createTaskboardServer, resolveHost, resolvePort, resolveServerOptions } from "./app.mjs";
import { syncReasonixProjects } from "./reasonix-projects.mjs";

export { createTaskboardServer, resolveHost, resolvePort, resolveServerOptions } from "./app.mjs";

async function main() {
  const resolved = resolveServerOptions();
  const app = createTaskboardServer({ databasePath: resolved.databasePath });
  const host = resolveHost();
  const address = await app.listen({ host, port: resolvePort() });
  console.log(`Codex Taskboard listening on http://127.0.0.1:${address.port}`);

  // 后台同步 Reasonix 项目（不阻塞启动）
  syncReasonixProjects(resolved.databasePath)
    .then((result) => {
      const created = result.created.length;
      const existing = result.existing.length;
      const skipped = result.skipped.length;
      if (created > 0 || existing > 0) {
        console.log(`Reasonix projects synced: ${created} created, ${existing} existing, ${skipped} skipped`);
      }
    })
    .catch((error) => {
      console.error(`Reasonix project sync failed: ${error.message}`);
    });
  if (host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`Codex Taskboard available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
