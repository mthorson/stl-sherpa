import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  Tooltip,
  UnstyledButton
} from '@mantine/core';
import {
  IconCircleFilled,
  IconDotsVertical,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderSearch,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconTrashX
} from '@tabler/icons-react';
import type { LibrarySummary } from '@shared/types';
import { NamePromptModal } from './NamePromptModal';

interface Props {
  libraries: LibrarySummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onReveal: (id: string) => void;
  onRelocate: (id: string) => void;
  onRescan: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveAndDeleteCache: (id: string) => void;
}

type ModalState =
  | { kind: 'none' }
  | { kind: 'rename'; library: LibrarySummary }
  | { kind: 'delete-cache'; library: LibrarySummary };

export function LibrarySidebar({
  libraries,
  selectedId,
  onSelect,
  onAdd,
  onRename,
  onReveal,
  onRelocate,
  onRescan,
  onRemove,
  onRemoveAndDeleteCache
}: Props) {
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const closeModal = () => setModal({ kind: 'none' });

  return (
    <Stack gap="xs" h="100%">
      <Group justify="space-between">
        <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
          Libraries
        </Text>
        <Tooltip label="Add library">
          <ActionIcon variant="subtle" size="sm" onClick={onAdd} aria-label="Add library">
            <IconFolderPlus size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {libraries.length === 0 ? (
        <Button leftSection={<IconFolderPlus size={16} />} variant="light" onClick={onAdd}>
          Add library
        </Button>
      ) : (
        <Stack gap={2}>
          {libraries.map((lib) => (
            <LibraryRow
              key={lib.id}
              library={lib}
              selected={lib.id === selectedId}
              onSelect={() => onSelect(lib.id)}
              onRename={() => setModal({ kind: 'rename', library: lib })}
              onReveal={() => onReveal(lib.id)}
              onRelocate={() => onRelocate(lib.id)}
              onRescan={() => onRescan(lib.id)}
              onRemove={() => onRemove(lib.id)}
              onRemoveAndDeleteCache={() => setModal({ kind: 'delete-cache', library: lib })}
            />
          ))}
        </Stack>
      )}

      <NamePromptModal
        opened={modal.kind === 'rename'}
        title="Rename library"
        confirmLabel="Rename"
        initial={modal.kind === 'rename' ? modal.library.name : ''}
        requireChange
        onCancel={closeModal}
        onConfirm={(name) => {
          if (modal.kind === 'rename') onRename(modal.library.id, name);
          closeModal();
        }}
      />

      <DeleteCacheModal
        opened={modal.kind === 'delete-cache'}
        library={modal.kind === 'delete-cache' ? modal.library : null}
        onCancel={closeModal}
        onConfirm={() => {
          if (modal.kind === 'delete-cache') onRemoveAndDeleteCache(modal.library.id);
          closeModal();
        }}
      />
    </Stack>
  );
}

function LibraryRow({
  library,
  selected,
  onSelect,
  onRename,
  onReveal,
  onRelocate,
  onRescan,
  onRemove,
  onRemoveAndDeleteCache
}: {
  library: LibrarySummary;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onReveal: () => void;
  onRelocate: () => void;
  onRescan: () => void;
  onRemove: () => void;
  onRemoveAndDeleteCache: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Both the kebab button and right-click on the row open the same Menu,
  // anchored to the kebab. Anchoring to cursor would need a portal hack —
  // anchoring to the row is good enough and stays inside Mantine's API.
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuOpen(true);
  };

  return (
    <Group
      gap={4}
      wrap="nowrap"
      onContextMenu={handleContextMenu}
      style={{
        borderRadius: 4,
        background: selected ? 'var(--mantine-color-dark-5)' : undefined
      }}
    >
      <UnstyledButton onClick={onSelect} style={{ flex: 1, padding: '6px 8px', minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap">
          <IconCircleFilled
            size={8}
            color={library.online ? 'var(--mantine-color-green-6)' : 'var(--mantine-color-gray-6)'}
          />
          <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" truncate>
              {library.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {library.mountPath}
            </Text>
          </Stack>
        </Group>
      </UnstyledButton>

      <Menu
        opened={menuOpen}
        onChange={setMenuOpen}
        position="bottom-end"
        shadow="md"
        withinPortal
        width={220}
      >
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`Actions for ${library.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <IconDotsVertical size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconPencil size={14} />} onClick={onRename}>
            Rename…
          </Menu.Item>
          <Menu.Item
            leftSection={<IconFolderOpen size={14} />}
            onClick={onReveal}
            disabled={!library.online}
          >
            Reveal in Finder
          </Menu.Item>
          <Menu.Item
            leftSection={<IconRefresh size={14} />}
            onClick={onRescan}
            disabled={!library.online}
          >
            Rescan
          </Menu.Item>
          <Menu.Item leftSection={<IconFolderSearch size={14} />} onClick={onRelocate}>
            Locate moved folder…
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item leftSection={<IconTrash size={14} />} onClick={onRemove}>
            Remove from app
          </Menu.Item>
          <Menu.Item
            leftSection={<IconTrashX size={14} />}
            color="red"
            onClick={onRemoveAndDeleteCache}
          >
            Remove and delete cache…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}


function DeleteCacheModal({
  opened,
  library,
  onCancel,
  onConfirm
}: {
  opened: boolean;
  library: LibrarySummary | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onCancel} title="Remove and delete cache?" centered size="md">
      <Stack gap="md">
        <Text size="sm">
          This removes <b>{library?.name}</b> from the app and deletes its{' '}
          <Text span ff="monospace" size="sm">
            .meshFlask.db
          </Text>{' '}
          and{' '}
          <Text span ff="monospace" size="sm">
            .meshFlask/
          </Text>{' '}
          thumbnail cache on disk.
        </Text>
        <Text size="sm" c="dimmed">
          Your 3D files are not touched. Re-adding the library will trigger a fresh scan and
          re-render of every thumbnail.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button color="red" onClick={onConfirm}>
            Delete cache
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
