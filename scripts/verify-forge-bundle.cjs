const path = require("node:path");
const { getNodeBundler, NativeUIBundler, getEntryPoints } = require("@forge/bundler");

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: (msg) => console.warn("[forge-bundler warn]", msg),
  error: (err) => console.error("[forge-bundler error]", err)
};

const stubWrapperProvider = {
  getNodeRuntimeWrapper: async () => ({
    script: "// stub wrapper",
    source: "local-stub",
    version: "1.0.0"
  }),
  getNodeRuntimeLoader: async () => ({
    script: "// stub loader",
    source: "local-stub",
    version: "1.0.0"
  })
};

const stubConfigReader = {
  readConfig: async () => ({
    app: { runtime: { name: "nodejs22.x" } }
  })
};

async function main() {
  const appDirectory = process.cwd();

  const handlers = [
    { module: "forge/index", func: "panelResolverHandler" },
    { module: "forge/index", func: "workflowValidatorHandler" },
    { module: "forge/index", func: "issueUpdatedTriggerHandler" },
    { module: "forge/index", func: "lifecycleInstallTriggerHandler" },
    { module: "forge/index", func: "migrationQueueConsumerHandler" },
    { module: "forge/index", func: "rovoInspectEcoHandler" },
    { module: "forge/index", func: "rovoSimulateCutoverHandler" },
    { module: "forge/index", func: "rovoCompareBaselinesHandler" },
    { module: "forge/index", func: "rovoFleetOverviewHandler" }
  ];

  const entryPoints = getEntryPoints(handlers);
  const nodeBundler = getNodeBundler(silentLogger, stubWrapperProvider, stubConfigReader);
  const nodeOut = await nodeBundler.bundle({
    appDirectory,
    entryPoints
  });
  console.log(`[forge-bundle] Node runtime bundle OK (${handlers.length} handlers) -> ${nodeOut.outputDir}`);

  const nativeUiBundler = new NativeUIBundler(silentLogger);
  const uiOut = await nativeUiBundler.bundleResources([
    {
      key: "main-ui",
      path: path.join(appDirectory, "src", "frontend", "index.tsx")
    },
    {
      key: "fleet-ui",
      path: path.join(appDirectory, "src", "frontend", "fleetPage.tsx")
    }
  ]);
  console.log(
    `[forge-bundle] Native UI Kit bundle OK -> ${uiOut.nativeUiBundlesDetails.map((d) => d.key).join(", ")}`
  );
}

main().catch((err) => {
  console.error("[forge-bundle] FAILED:", err);
  process.exit(1);
});
