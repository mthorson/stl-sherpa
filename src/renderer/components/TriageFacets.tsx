import { ActionIcon, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconCircleFilled, IconStarFilled } from '@tabler/icons-react';
import { COLOR_LABELS, COLOR_LABEL_HEX, type ColorLabel } from '@shared/ratings';

interface Props {
  minRating: number;
  colorLabels: ReadonlySet<ColorLabel>;
  onSetMinRating: (rating: number) => void;
  onToggleLabel: (label: ColorLabel) => void;
  /** When true, suppress the internal "Triage" header — the caller (e.g.
   *  CollapsibleSection) is providing one. */
  headerless?: boolean;
}

/**
 * Compact triage facets. Star row + color-label row. The caller decides
 * where this lives in the sidebar and (via `headerless`) whether the
 * internal header is shown.
 */
export function TriageFacets({
  minRating,
  colorLabels,
  onSetMinRating,
  onToggleLabel,
  headerless = false
}: Props) {
  const hasActiveFilter = minRating > 0 || colorLabels.size > 0;
  const clearAll = () => {
    onSetMinRating(0);
    for (const c of colorLabels) onToggleLabel(c);
  };
  return (
    <Stack gap={4}>
      {!headerless && (
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
            Triage
          </Text>
          {hasActiveFilter && (
            <Tooltip label="Clear triage filters">
              <ActionIcon variant="subtle" size="xs" onClick={clearAll} aria-label="Clear triage filters">
                <Text size="xs">×</Text>
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      )}
      {headerless && hasActiveFilter && (
        <Group justify="flex-end">
          <Tooltip label="Clear triage filters">
            <ActionIcon variant="subtle" size="xs" onClick={clearAll} aria-label="Clear triage filters">
              <Text size="xs">×</Text>
            </ActionIcon>
          </Tooltip>
        </Group>
      )}

      <Group gap={2} wrap="nowrap">
        {[1, 2, 3, 4, 5].map((n) => {
          const active = minRating === n;
          return (
            <Tooltip key={n} label={`Rated ${n}+`} withinPortal>
              <UnstyledButton
                onClick={() => onSetMinRating(active ? 0 : n)}
                style={{
                  flex: 1,
                  padding: '4px 0',
                  borderRadius: 4,
                  textAlign: 'center',
                  fontSize: 11,
                  background: active ? 'var(--mantine-color-dark-5)' : 'transparent',
                  border: active
                    ? '1px solid var(--mantine-color-indigo-5)'
                    : '1px solid var(--mantine-color-dark-4)'
                }}
                aria-label={`Filter to rating ${n} or higher`}
              >
                <Group gap={2} justify="center" wrap="nowrap">
                  <IconStarFilled size={10} color="var(--mantine-color-yellow-5)" />
                  <Text component="span" size="xs">
                    {n}+
                  </Text>
                </Group>
              </UnstyledButton>
            </Tooltip>
          );
        })}
      </Group>

      <Group gap={6} wrap="nowrap" style={{ paddingTop: 4 }}>
        {COLOR_LABELS.map((c) => {
          const active = colorLabels.has(c);
          return (
            <Tooltip key={c} label={`Filter ${c}`} withinPortal>
              <UnstyledButton
                onClick={() => onToggleLabel(c)}
                style={{
                  padding: 2,
                  borderRadius: 4,
                  border: active
                    ? '1.5px solid var(--mantine-color-indigo-5)'
                    : '1.5px solid transparent'
                }}
                aria-label={`Toggle ${c} filter`}
              >
                <IconCircleFilled size={16} color={COLOR_LABEL_HEX[c]} />
              </UnstyledButton>
            </Tooltip>
          );
        })}
      </Group>
    </Stack>
  );
}
