import type { ModelProvider } from "./types.js";

// Picks which model answers a conversation. The choice is made when the
// conversation starts, because a transcript can't move between providers.
//
// Target setup for O'Dea: the on-site model is primary (data stays in the
// building); Claude is an optional fallback for when the local model is down
// or can't handle a photo. Before the GPU arrives, Claude can be primary.
//
// Rules, in order:
//   1. A conversation marked local-only always uses the local model.
//   2. A photo needs a vision-capable model.
//   3. Otherwise the primary, then the fallback.

export interface RouteRequest {
  localOnly?: boolean;
  hasImage?: boolean;
}

export interface RouterModels {
  primary?: ModelProvider;
  /** Used when the primary can't take the request or is unreachable. */
  fallback?: ModelProvider;
  /** The on-site model, for local-only conversations (often the same as primary). */
  local?: ModelProvider;
}

export class ModelRouter {
  private readonly order: ModelProvider[];

  constructor(private readonly models: RouterModels) {
    this.order = [models.primary, models.fallback].filter((p): p is ModelProvider => !!p);
    if (!this.order.length && !models.local) {
      throw new Error("No model configured: set OLLAMA_URL and/or ANTHROPIC_API_KEY.");
    }
  }

  pick(req: RouteRequest): ModelProvider {
    if (req.localOnly) {
      const local = this.models.local;
      if (!local) throw new RouteError("This conversation needs the on-site model, which isn't configured.");
      if (req.hasImage && !local.supportsVision) throw new RouteError(`${local.id} can't read photos.`);
      return local;
    }
    const usable = this.order.find((p) => !req.hasImage || p.supportsVision);
    if (!usable) throw new RouteError(req.hasImage ? "No configured model can read photos." : "No model configured.");
    return usable;
  }

  /** The next model to try after `failed` couldn't be reached, if any. */
  fallbackAfter(failed: ModelProvider, req: RouteRequest): ModelProvider | undefined {
    if (req.localOnly) return undefined;
    const i = this.order.indexOf(failed);
    return this.order.slice(i + 1).find((p) => !req.hasImage || p.supportsVision);
  }

  describe(): { primary?: string; fallback?: string; local?: string } {
    return { primary: this.models.primary?.id, fallback: this.models.fallback?.id, local: this.models.local?.id };
  }
}

export class RouteError extends Error {}
