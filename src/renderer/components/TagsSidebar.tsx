import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Group,
  Menu,
  Stack,
  Text,
  Tooltip,
  UnstyledButton
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconDotsVertical,
  IconHash,
  IconTrash
} from '@tabler/icons-react';
import type { TagTreeNode, TagWithCount } from '@shared/types';
import { ipc } from '../ipc-client';

interface Props {
  libraryId: string | null;
  /** Flat list with counts — kept so the parent's tag-changed broadcasts re-render us. */
  tags: TagWithCount[];
  selectedTagIds: Set<number>;
  onToggle: (tagId: number) => void;
  onClear: () => void;
  onDelete: (tagId: number) => void;
  /** Suppress the internal "Tags" header when the caller is providing one. */
  headerless?: boolean;
}

/**
 * Hierarchical tag tree. Each node is a clickable facet (toggles inclusion
 * in the current filter). Parents include their descendants when filtering
 * (query layer does the recursive expansion). Right-click → kebab menu for
 * delete (rename + reparent live in a future iteration).
 */
export function TagsSidebar({
  libraryId,
  tags,
  selectedTagIds,
  onToggle,
  onClear,
  onDelete,
  headerless = false
}: Props) {
  const [tree, setTree] = useState<TagTreeNode[]>([]);

  // Reload the tree whenever the flat list changes (the parent already
  // refreshes its flat list on tags-changed events).
  useEffect(() => {
    if (!libraryId) {
      setTree([]);
      return;
    }
    let cancelled = false;
    void ipc.listTagTree(libraryId).then((next) => {
      if (!cancelled) setTree(next);
    });
    return () => {
      cancelled = true;
    };
  }, [libraryId, tags]);

  return (
    <Stack gap={4}>
      {!headerless && (
        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
            Tags
          </Text>
          {selectedTagIds.size > 0 && (
            <Tooltip label="Clear tag filter">
              <ActionIcon variant="subtle" size="xs" onClick={onClear} aria-label="Clear tag filter">
                <Text size="xs">×</Text>
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      )}
      {headerless && selectedTagIds.size > 0 && (
        <Group justify="flex-end">
          <Tooltip label="Clear tag filter">
            <ActionIcon variant="subtle" size="xs" onClick={onClear} aria-label="Clear tag filter">
              <Text size="xs">×</Text>
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
      {tree.length === 0 ? (
        <Text size="xs" c="dimmed">
          No tags yet. Add tags to a file from the metadata panel.
        </Text>
      ) : (
        <Stack gap={2}>
          {tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              selected={selectedTagIds}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  onToggle,
  onDelete
}: {
  node: TagTreeNode;
  depth: number;
  selected: Set<number>;
  onToggle: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const active = selected.has(node.id);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <Group
        gap={2}
        wrap="nowrap"
        style={{
          paddingLeft: depth * 10,
          borderRadius: 4,
          background: active ? 'var(--mantine-color-dark-5)' : undefined
        }}
      >
        <ActionIcon
          variant="transparent"
          size="xs"
          onClick={() => hasChildren && setExpanded((v) => !v)}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
        </ActionIcon>
        <UnstyledButton
          onClick={() => onToggle(node.id)}
          style={{ flex: 1, padding: '3px 4px', minWidth: 0 }}
        >
          <Group gap={4} wrap="nowrap">
            <IconHash size={11} color={active ? 'var(--mantine-color-indigo-4)' : undefined} />
            <Text size="sm" truncate style={{ flex: 1 }}>
              {node.name}
            </Text>
            <Badge size="xs" variant="light" color="gray">
              {node.fileCount}
            </Badge>
          </Group>
        </UnstyledButton>
        <Menu position="bottom-end" withinPortal width={140} shadow="md">
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="xs"
              aria-label={`Actions for ${node.name}`}
              onClick={(e) => e.stopPropagation()}
            >
              <IconDotsVertical size={10} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<IconTrash size={12} />}
              color="red"
              onClick={() => onDelete(node.id)}
            >
              Delete
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      {expanded &&
        node.children.map((child) => (
          <TreeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selected={selected}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        ))}
    </>
  );
}
