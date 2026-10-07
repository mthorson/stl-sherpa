import { ActionIcon, Group, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconBox } from '@tabler/icons-react';
import type { PrintBed } from '@shared/preferences';

interface Props {
  beds: PrintBed[];
  selectedBedId: string | null;
  onChange: (bedId: string | null) => void;
}

/**
 * Sidebar facet for filtering the grid to files that fit a selected printer
 * bed. The actual filtering happens client-side in App.tsx by checking each
 * file's bounding box against the bed's dimensions (see modelFitsSpecificBed).
 */
export function PrintBedFacet({ beds, selectedBedId, onChange }: Props) {
  if (beds.length === 0) return null;
  return (
    <Stack gap={2}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap={4} wrap="nowrap">
          <IconBox size={11} />
          <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
            Fits bed
          </Text>
        </Group>
        {selectedBedId != null && (
          <Tooltip label="Clear bed filter">
            <ActionIcon variant="subtle" size="xs" onClick={() => onChange(null)} aria-label="Clear bed filter">
              <Text size="xs">×</Text>
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      <Select
        size="xs"
        value={selectedBedId}
        onChange={onChange}
        data={beds.map((b) => ({
          value: b.id,
          label: `${b.name}  (${b.x}×${b.y}×${b.z})`
        }))}
        placeholder="Any size"
        clearable
        comboboxProps={{ withinPortal: true }}
      />
    </Stack>
  );
}
