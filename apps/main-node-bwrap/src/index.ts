// Node self-host with the bubblewrap sandbox: same assembly as main-node's
// own entrypoint, but the sandbox factory is passed explicitly, so
// SANDBOX_PROVIDER is not consulted. Configuration: see
// packages/sandbox-adapter-bwrap/src/options.ts (OMA_BWRAP_*).
import { nodeDefaults } from "@open-managed-agents/main-node/components";
import { loadNodeConfig } from "@open-managed-agents/main-node/config";
import { createNodeControlPlane } from "@open-managed-agents/main-node/control-plane";
import { serveNodeControlPlane } from "@open-managed-agents/main-node/serve";
import { createBwrapSandboxFactory, loadBwrapOptions } from "@open-managed-agents/sandbox-adapter-bwrap";

const config = loadNodeConfig(process.env);
const sandbox = createBwrapSandboxFactory(loadBwrapOptions(process.env));
const controlPlane = await createNodeControlPlane(await nodeDefaults(config, { sandbox }));
if (controlPlane.processMode === "standalone") {
  await controlPlane.start();
  await serveNodeControlPlane(controlPlane, { ...config.http, signals: {} });
}
