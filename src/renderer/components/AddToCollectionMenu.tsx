import { useState } from 'react';
import { Button, Menu } from '@mantine/core';
import { IconFolderPlus, IconPlus, IconFolders } from '@tabler/icons-react';
import type { CollectionRecord, CollectionWithCount } from '@shared/types';
import { NamePromptModal } from './NamePromptModal';

interface Props {
  collections: CollectionWithCount[];
  /** File ids the action should target. Disabled when empty. */
  fileIds: number[];
  onAdd: (collectionId: number, fileIds: number[]) => Promise<void> | void;
  /** Returns the newly created collection (or null on failure). */
  onCreate: (name: string) => Promise<CollectionRecord | null>;
}

/**
 * Trigger button + dropdown to add the supplied file ids to an existing
 * collection, with an inline "+ New collection…" affordance that opens a
 * small naming modal. Auto-adds the files to the new collection on create.
 */
export function AddToCollectionMenu({ collections, fileIds, onAdd, onCreate }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const disabled = fileIds.length === 0;

  return (
    <>
      <Menu position="bottom-end" shadow="md" withinPortal width={240}>
        <Menu.Target>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconFolderPlus size={14} />}
            disabled={disabled}
          >
            Add to collection…
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {collections.length === 0 ? (
            <Menu.Label>No collections yet</Menu.Label>
          ) : (
            <>
              <Menu.Label>Existing</Menu.Label>
              {collections.map((c) => (
                <Menu.Item
                  key={c.id}
                  leftSection={<IconFolders size={14} />}
                  onClick={() => void onAdd(c.id, fileIds)}
                >
                  {c.name}
                </Menu.Item>
              ))}
              <Menu.Divider />
            </>
          )}
          <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => setCreateOpen(true)}>
            New collection…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <NamePromptModal
        opened={createOpen}
        title="New collection"
        confirmLabel="Create & add"
        onCancel={() => setCreateOpen(false)}
        onConfirm={async (name) => {
          setCreateOpen(false);
          const created = await onCreate(name);
          if (created) await onAdd(created.id, fileIds);
        }}
      />
    </>
  );
}
