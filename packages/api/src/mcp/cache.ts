import { logger } from '@librechat/data-schemas';
import type { MCPAllowlists } from './registry/MCPServersRegistry';
import { MCPServersRegistry } from './registry/MCPServersRegistry';
import { MCPManager } from './MCPManager';

/**
 * The `mcpSettings` subset the registry captures once per process.
 * The request-time allowlists resolve per call; these are the boot/fallback copies.
 */
export interface MCPBootSettings {
  allowedDomains?: string[] | null;
  allowedAddresses?: string[] | null;
}

/**
 * Re-applies caller-resolved MCP boot settings to the live registry.
 *
 * An admin-panel `mcpSettings` change reaches request-time decisions on its own, since
 * `MCPServersRegistry.resolveAllowlists` reads the merged config per call. What it does
 * not reach is the boot/fallback copy the registry was constructed with — the value used
 * when the injected resolver is missing or throws, and the one the cluster init
 * fingerprint is computed from. This refreshes that copy so an operator's edit is not
 * the only kind that needs a restart.
 *
 * Best-effort and safe before boot: returns false, without throwing, when the registry
 * has not been created yet, so an admin save landing during startup cannot fail and
 * cannot install settings the boot path is about to write over.
 *
 * Only the allowlists are boot-captured. `mcpSettings.catalogRecovery` is read per call
 * on the recovery paths, so it needs no refresh — with one exception this cannot reach:
 * the recovery tracker's state budget is bound when `MCPManager` is constructed.
 *
 * @returns whether a live registry received the settings.
 */
export function applyMCPBootConfig(settings?: MCPBootSettings | null): boolean {
  let registry: MCPServersRegistry;
  try {
    registry = MCPServersRegistry.getInstance();
  } catch {
    return false;
  }

  const allowlists: MCPAllowlists = {
    allowedDomains: settings?.allowedDomains,
    allowedAddresses: settings?.allowedAddresses,
  };
  registry.applyBaseAllowlists(allowlists);
  return true;
}

/**
 * Clears config-source MCP server inspection cache so servers are re-inspected on next access.
 * Best-effort disconnection of app-level connections for evicted servers.
 *
 * User-level connections (used by config-source servers) are cleaned up lazily via
 * the stale-check mechanism on the next tool call — this is an accepted design tradeoff
 * since iterating all active user sessions is expensive and config mutations are rare.
 */
export async function clearMcpConfigCache(): Promise<void> {
  let registry: MCPServersRegistry;
  try {
    registry = MCPServersRegistry.getInstance();
  } catch {
    return;
  }

  let evictedServers: string[];
  try {
    evictedServers = await registry.invalidateConfigCache();
  } catch (error) {
    logger.error('[clearMcpConfigCache] Failed to invalidate config cache:', error);
    return;
  }

  if (!evictedServers.length) {
    return;
  }

  try {
    const mcpManager = MCPManager.getInstance();
    if (mcpManager?.appConnections) {
      await Promise.allSettled(
        evictedServers.map((serverName) => mcpManager.appConnections!.disconnect(serverName)),
      );
    }
  } catch {
    // MCPManager not yet initialized — connections cleaned up lazily
  }
}
