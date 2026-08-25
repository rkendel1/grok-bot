import type { HostExtensionContext } from "../../../internal/host-extensions.js";
import type { SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import { createCursorWebFetchService, createCursorWebSearchService } from "./cursor-web-tools.js";
import { createHostInference } from "./inference-service.js";
import type { InferenceExtensionContext } from "./extension.js";
import { InferenceGatewayAPI } from "./inference-api.js";
import type { FeltDBClient } from "../../../packages/feltdb-operations/feltdb-client.js";

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: InferenceExtensionContext["deps"] & { feltdb?: FeltDBClient };
};

/** Recreates the artifact's concrete inference construction at host-main.cjs:617672-617732. */
export function createInferenceProductionExtras(
  context: ProductionContext,
): Omit<InferenceExtensionContext, "deps"> & { inferenceApi?: InferenceGatewayAPI } {
  const auth = context.deps.auth;
  const feltdb = context.deps.feltdb;

  // Create inference gateway API if FeltDB is available
  let inferenceApi: InferenceGatewayAPI | undefined;
  if (feltdb) {
    inferenceApi = new InferenceGatewayAPI(feltdb);
  }

  return {
    createPort(onModelExperimentApplied) {
      return createHostInference({
        auth,
        experiments: context.deps.experiments,
        settings: context.deps.settings,
        onModelExperimentApplied,
      });
    },
    createWebSearch(args) {
      const request = args as { modelId: string; onRequestId?: (requestId: string) => void };
      return createCursorWebSearchService({
        getAccessToken: auth.getAccessToken,
        getMachineId: auth.getMachineId,
        modelId: request.modelId,
        ...(request.onRequestId == null ? {} : { onRequestId: request.onRequestId }),
      });
    },
    createWebFetch(args) {
      const request = args as { onRequestId?: (requestId: string) => void };
      return createCursorWebFetchService({
        getAccessToken: auth.getAccessToken,
        getMachineId: auth.getMachineId,
        ...(request.onRequestId == null ? {} : { onRequestId: request.onRequestId }),
      });
    },
    // Phase 3.4: Inference Gateway API
    ...(inferenceApi ? { inferenceApi } : {}),
  };
}

export type InferenceModelSelection = SandAgentModelSelection;
