import { ActionIcon, Group, SegmentedControl, Select, Tooltip } from '@mantine/core';
import {
  IconArrowDown,
  IconArrowUp,
  IconLayoutGrid,
  IconLayoutList
} from '@tabler/icons-react';
import { SORT_FIELDS, SORT_LABELS, type SortField, type SortSpec } from '@shared/sort';

export type ViewMode = 'grid' | 'list';

interface Props {
  sort: SortSpec;
  onSortChange: (sort: SortSpec) => void;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
}

/**
 * Toolbar at the top of the grid pane with sort field + direction + view
 * switcher. Sort changes propagate to App.tsx which re-runs the query;
 * view changes swap the body between ThumbGrid and FileListView.
 */
export function ViewSortToolbar({ sort, onSortChange, view, onViewChange }: Props) {
  return (
    <Group gap={6} wrap="nowrap">
      <Select
        size="xs"
        w={120}
        value={sort.field}
        onChange={(v) => v && onSortChange({ ...sort, field: v as SortField })}
        data={SORT_FIELDS.map((f) => ({ value: f, label: SORT_LABELS[f] }))}
        comboboxProps={{ withinPortal: true }}
        allowDeselect={false}
      />
      <Tooltip
        label={sort.direction === 'asc' ? 'Ascending. Click to reverse.' : 'Descending. Click to reverse.'}
        withinPortal
      >
        <ActionIcon
          size="sm"
          variant="default"
          onClick={() =>
            onSortChange({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' })
          }
          aria-label={`Toggle sort direction (currently ${sort.direction})`}
        >
          {sort.direction === 'asc' ? <IconArrowUp size={14} /> : <IconArrowDown size={14} />}
        </ActionIcon>
      </Tooltip>
      <SegmentedControl
        size="xs"
        value={view}
        onChange={(v) => onViewChange(v as ViewMode)}
        data={[
          {
            value: 'grid',
            label: (
              <Group gap={4} wrap="nowrap">
                <IconLayoutGrid size={12} />
              </Group>
            )
          },
          {
            value: 'list',
            label: (
              <Group gap={4} wrap="nowrap">
                <IconLayoutList size={12} />
              </Group>
            )
          }
        ]}
      />
    </Group>
  );
}
