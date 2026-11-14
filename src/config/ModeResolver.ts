import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';

function isSelectGroup(
  item: SessionConfigSelectOption | SessionConfigSelectGroup,
): item is SessionConfigSelectGroup {
  return 'options' in item && Array.isArray((item as SessionConfigSelectGroup).options);
}

function flattenSelectOptions(
  options: Array<SessionConfigSelectOption | SessionConfigSelectGroup>,
): SessionConfigSelectOption[] {
  const flat: SessionConfigSelectOption[] = [];
  for (const item of options) {
    if (isSelectGroup(item)) {
      flat.push(...item.options);
    } else {
      flat.push(item);
    }
  }
  return flat;
}

/**
 * Return the currently active mode ID from `configOptions` (category === 'mode')
 * or legacy `modes.currentModeId`.
 */
export function getCurrentModeId(
  modes: SessionModeState | null,
  configOptions: SessionConfigOption[] | null,
): string | null {
  const modeOpt = configOptions?.find((o) => o.category === 'mode' && o.type === 'select');
  if (modeOpt && modeOpt.type === 'select') {
    return modeOpt.currentValue ?? null;
  }
  return modes?.currentModeId ?? null;
}

/**
 * Resolve a preferred mode ID or name against the session's advertised modes.
 * Matches exact ID/value first, then case-insensitive ID/value or name.
 */
export function resolvePreferredModeId(
  preferred: string,
  modes: SessionModeState | null,
  configOptions: SessionConfigOption[] | null,
): string | null {
  const target = preferred.trim();
  if (!target) {
    return null;
  }
  const targetLower = target.toLowerCase();

  const modeOpt = configOptions?.find((o) => o.category === 'mode' && o.type === 'select');
  if (modeOpt && modeOpt.type === 'select') {
    const flat = flattenSelectOptions(modeOpt.options);
    const exact = flat.find((o) => o.value === target);
    if (exact) {
      return exact.value;
    }
    const ci = flat.find(
      (o) => o.value.toLowerCase() === targetLower || o.name.toLowerCase() === targetLower,
    );
    return ci ? ci.value : null;
  }

  const available = modes?.availableModes;
  if (!available || available.length === 0) {
    return null;
  }
  const exact = available.find((m) => m.id === target);
  if (exact) {
    return exact.id;
  }
  const ci = available.find(
    (m) => m.id.toLowerCase() === targetLower || m.name.toLowerCase() === targetLower,
  );
  return ci ? ci.id : null;
}
