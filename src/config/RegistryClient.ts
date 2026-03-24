import { log, logError } from '../utils/Logger';

interface RegistryAgent {
  name: string;
  description?: string;
  command: string;
  args?: string[];
  homepage?: string;
}

interface Registry {
  agents: RegistryAgent[];
}

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const FETCH_TIMEOUT = 30000; // 30 seconds

let cachedRegistry: Registry | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the ACP agent registry from the CDN.
 * Results are cached for 5 minutes.
 */
export async function fetchRegistry(): Promise<RegistryAgent[]> {
  const now = Date.now();
  if (cachedRegistry && (now - cacheTime) < CACHE_TTL) {
    return cachedRegistry.agents;
  }

  try {
    log('Fetching ACP agent registry...');
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT);

    let response: Response;
    try {
      response = await fetch(REGISTRY_URL, { signal: abortController.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = (await response.json()) as Registry;
    cachedRegistry = data;
    cacheTime = now;
    log(`Registry fetched: ${data.agents?.length || 0} agents`);
    return data.agents || [];
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      log(`Registry fetch timed out after ${FETCH_TIMEOUT}ms`);
    }
    logError('Failed to fetch registry', e);
    return cachedRegistry?.agents || [];
  }
}

/**
 * Clear the registry cache.
 */
export function clearRegistryCache(): void {
  cachedRegistry = null;
  cacheTime = 0;
}
