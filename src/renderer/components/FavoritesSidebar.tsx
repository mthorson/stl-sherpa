import { ActionIcon, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconFolder, IconStar, IconStarOff } from '@tabler/icons-react';

interface Props {
  /** Folder paths to show in the list. */
  paths: string[];
  /** The currently selected folder path — used to highlight the active row. */
  selectedPath: string;
  onSelect: (path: string) => void;
  /** Toggle pin/unpin. */
  onToggleFavorite: (path: string) => void;
  /** Whether a row is currently a favorite (drives star fill/icon). */
  isFavorite: (path: string) => boolean;
}

/**
 * Headerless list of folder rows used in the pinned-bottom Favorites/Recent
 * sections. The caller wraps this in a `CollapsibleSection` and decides which
 * subset of paths to feed in.
 */
export function FolderRowList({
  paths,
  selectedPath,
  onSelect,
  onToggleFavorite,
  isFavorite
}: Props) {
  if (paths.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        Nothing here yet.
      </Text>
    );
  }
  return (
    <Stack gap={2}>
      {paths.map((p) => (
        <Row
          key={p}
          path={p}
          active={p === selectedPath}
          isFavorite={isFavorite(p)}
          onSelect={() => onSelect(p)}
          onToggleFavorite={() => onToggleFavorite(p)}
        />
      ))}
    </Stack>
  );
}

function Row({
  path,
  active,
  isFavorite,
  onSelect,
  onToggleFavorite
}: {
  path: string;
  active: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  const display = path === '' ? '(library root)' : path.split('/').slice(-1)[0];
  const parent = path === '' ? '' : path.split('/').slice(0, -1).join('/');
  return (
    <Group
      gap={2}
      wrap="nowrap"
      style={{
        borderRadius: 4,
        background: active ? 'var(--mantine-color-dark-5)' : undefined
      }}
    >
      <UnstyledButton
        onClick={onSelect}
        style={{ flex: 1, padding: '3px 6px', minWidth: 0 }}
      >
        <Group gap={6} wrap="nowrap">
          <IconFolder size={12} />
          <Text size="sm" truncate style={{ flex: 1 }}>
            {display}
          </Text>
          {parent && (
            <Text size="xs" c="dimmed" truncate style={{ maxWidth: 80 }}>
              {parent}
            </Text>
          )}
        </Group>
      </UnstyledButton>
      <Tooltip label={isFavorite ? 'Unpin from favorites' : 'Pin to favorites'}>
        <ActionIcon
          variant="subtle"
          color={isFavorite ? 'yellow' : 'gray'}
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-label={isFavorite ? 'Unpin' : 'Pin'}
        >
          {isFavorite ? <IconStar size={11} /> : <IconStarOff size={11} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
