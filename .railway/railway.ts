import { defineRailway, project, service, volume } from "railway/iac";

// This partial owns the gateway and its existing volume in the selected environment.
export const partial = "gateway";

export default defineRailway((ctx) => {
  if (ctx.projectName && ctx.projectName !== "platform")
    throw new Error("Select the platform Railway project before planning this migration.");
  if (ctx.environment !== "staging" && ctx.environment !== "production")
    throw new Error("Select the staging or production Railway environment explicitly.");

  // Match the existing resource by name. Renaming it could attach an empty volume.
  const data = volume("gateway-volume", { region: "us-west2", sizeMB: 50000 });
  const gateway = service("gateway", {
    // The Dockerfile belongs to the frozen platform package uploaded by the owner.
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/health",
    replicas: { "us-west2": 1 },
    deploy: {
      drainingSeconds: 45,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    domains: [{
      domain: ctx.environment === "staging" ? "api.dev.multiagency.ai" : "api.multiagency.ai",
      port: 8080,
    }],
    volumeMounts: { "/data": data },
  });

  // CLI 5.71 supports this policy; railway@3.16.0 does not yet declare it in ProjectDefinition.
  // Keeping variables unmanaged preserves every existing name and secret without importing values.
  return { ...project("platform", { resources: [gateway, data] }), variables: { managed: false } };
});
