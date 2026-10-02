import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  Button
} from '@mantine/core';
import {
  IconBolt,
  IconDotsVertical,
  IconFileExport,
  IconFolders,
  IconFolderSearch,
  IconPackageExport,
  IconPencil,
  IconPlus,
  IconTrash
} from '@tabler/icons-react';
import type { CollectionWithCount } from '@shared/types';
import { NamePromptModal } from './NamePromptModal';

interface Props {
  collections: CollectionWithCount[];
  selectedCollectionId: number | null;
  onSelect: (id: number | null) => void;
  onCreate: (name: string) => void;
  onCreateSmart: () => void;
  onEditSmart: (collection: CollectionWithCount) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  onExportZip: (id: number) => void;
  onExportContactSheet: (id: number) => void;
}

type ModalState =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'rename'; collection: CollectionWithCount }
  | { kind: 'delete'; collection: CollectionWithCount };

export function CollectionsSidebar({
  collections,
  selectedCollectionId,
  onSelect,
  onCreate,
  onCreateSmart,
  onEditSmart,
  onRename,
  onDelete,
  onExportZip,
  onExportContactSheet
}: Props) {
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const close = () => setModal({ kind: 'none' });

  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
          Collections
        </Text>
        <Group gap={2} wrap="nowrap">
          <Tooltip label="New smart collection">
            <ActionIcon
              variant="subtle"
              size="xs"
              onClick={onCreateSmart}
              aria-label="New smart collection"
            >
              <IconBolt size={12} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="New collection">
            <ActionIcon
              variant="subtle"
              size="xs"
              onClick={() => setModal({ kind: 'create' })}
              aria-label="New collection"
            >
              <IconPlus size={12} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {collections.length === 0 ? (
        <Text size="xs" c="dimmed">
          Group files for export or print batches. Click + to create one.
        </Text>
      ) : (
        <Stack gap={2}>
          {collections.map((c) => (
            <CollectionRow
              key={c.id}
              collection={c}
              active={c.id === selectedCollectionId}
              onSelect={() => onSelect(c.id === selectedCollectionId ? null : c.id)}
              onRename={() => setModal({ kind: 'rename', collection: c })}
              onDelete={() => setModal({ kind: 'delete', collection: c })}
              onEditSmart={() => onEditSmart(c)}
              onExportZip={() => onExportZip(c.id)}
              onExportContactSheet={() => onExportContactSheet(c.id)}
            />
          ))}
        </Stack>
      )}

      <NamePromptModal
        opened={modal.kind === 'create'}
        title="New collection"
        initial=""
        confirmLabel="Create"
        onCancel={close}
        onConfirm={(name) => {
          onCreate(name);
          close();
        }}
      />
      <NamePromptModal
        opened={modal.kind === 'rename'}
        title="Rename collection"
        initial={modal.kind === 'rename' ? modal.collection.name : ''}
        confirmLabel="Rename"
        onCancel={close}
        onConfirm={(name) => {
          if (modal.kind === 'rename') onRename(modal.collection.id, name);
          close();
        }}
      />
      <DeleteModal
        opened={modal.kind === 'delete'}
        collection={modal.kind === 'delete' ? modal.collection : null}
        onCancel={close}
        onConfirm={() => {
          if (modal.kind === 'delete') onDelete(modal.collection.id);
          close();
        }}
      />
    </Stack>
  );
}

function CollectionRow({
  collection,
  active,
  onSelect,
  onRename,
  onDelete,
  onEditSmart,
  onExportZip,
  onExportContactSheet
}: {
  collection: CollectionWithCount;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onEditSmart: () => void;
  onExportZip: () => void;
  onExportContactSheet: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isSmart = collection.smartQuery != null;

  return (
    <Group
      gap={4}
      wrap="nowrap"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      style={{
        borderRadius: 4,
        background: active ? 'var(--mantine-color-dark-5)' : undefined
      }}
    >
      <UnstyledButton
        onClick={onSelect}
        style={{ flex: 1, padding: '4px 6px', minWidth: 0 }}
      >
        <Group gap={6} wrap="nowrap">
          {isSmart ? (
            <IconFolderSearch
              size={12}
              color={active ? 'var(--mantine-color-indigo-4)' : 'var(--mantine-color-indigo-6)'}
            />
          ) : (
            <IconFolders
              size={12}
              color={active ? 'var(--mantine-color-indigo-4)' : undefined}
            />
          )}
          <Text size="sm" truncate style={{ flex: 1 }}>
            {collection.name}
          </Text>
          {!isSmart && (
            <Badge size="xs" variant="light" color="gray">
              {collection.fileCount}
            </Badge>
          )}
        </Group>
      </UnstyledButton>
      <Menu
        opened={menuOpen}
        onChange={setMenuOpen}
        position="bottom-end"
        shadow="md"
        withinPortal
        width={180}
      >
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="xs"
            aria-label={`Actions for ${collection.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <IconDotsVertical size={12} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {isSmart && (
            <Menu.Item leftSection={<IconBolt size={14} />} onClick={onEditSmart}>
              Edit query…
            </Menu.Item>
          )}
          <Menu.Item leftSection={<IconPencil size={14} />} onClick={onRename}>
            Rename…
          </Menu.Item>
          {!isSmart && (
            <Menu.Item leftSection={<IconPackageExport size={14} />} onClick={onExportZip}>
              Export as ZIP…
            </Menu.Item>
          )}
          <Menu.Item leftSection={<IconFileExport size={14} />} onClick={onExportContactSheet}>
            Contact sheet (PDF)…
          </Menu.Item>
          <Menu.Item leftSection={<IconTrash size={14} />} color="red" onClick={onDelete}>
            Delete…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}


function DeleteModal({
  opened,
  collection,
  onCancel,
  onConfirm
}: {
  opened: boolean;
  collection: CollectionWithCount | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onCancel} title="Delete collection?" centered size="sm">
      <Stack gap="md">
        <Text size="sm">
          Delete <b>{collection?.name}</b>? The {collection?.fileCount ?? 0} file
          {collection?.fileCount === 1 ? '' : 's'} inside remain on disk and in the library — only
          the collection grouping is removed.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button color="red" onClick={onConfirm}>
            Delete
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
