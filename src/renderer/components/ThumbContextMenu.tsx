import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Autocomplete,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  UnstyledButton
} from '@mantine/core';
import {
  IconAppWindow,
  IconCircleFilled,
  IconCircleMinus,
  IconCircleX,
  IconExternalLink,
  IconFolderOpen,
  IconFolderPlus,
  IconFolders,
  IconHash,
  IconPlus,
  IconEdit,
  IconRefresh,
  IconRotateClockwise,
  IconStarFilled,
  IconStarOff,
  IconTag,
  IconTagOff,
  IconCopy,
  IconTrash
} from '@tabler/icons-react';
import type {
  CollectionRecord,
  CollectionWithCount,
  ColorLabel,
  FileRecord,
  TagRecord,
  TagWithCount
} from '@shared/types';
import { UP_AXIS_OPTIONS, type FileOrientation, type UpAxis } from '@shared/orientation';
import { COLOR_LABELS, COLOR_LABEL_HEX } from '@shared/ratings';
import type { ExternalAppRegistration } from '@shared/preferences';
import { ipc } from '../ipc-client';
import { hasActiveComboboxOption } from '../util/combobox';
import { NamePromptModal } from './NamePromptModal';

interface Props {
  opened: boolean;
  /** Viewport coordinates of the click that opened the menu. */
  x: number;
  y: number;
  onClose: () => void;

  libraryId: string;
  selectedFiles: FileRecord[];
  /** Primary (right-clicked) file for single-file actions like Open with / Reveal. */
  primaryFile: FileRecord | null;
  onOpenPreferences: () => void;

  allTags: TagWithCount[];
  collections: CollectionWithCount[];
  /** Non-null when the user is currently viewing a collection. */
  activeCollectionId: number | null;

  onBulkAddTag: (tagName: string) => Promise<void>;
  onBulkRemoveTag: (tagId: number) => Promise<void>;
  onBulkSetOrientation: (orientation: FileOrientation | null) => Promise<void>;
  onBulkSetRating: (rating: number) => Promise<void>;
  onBulkSetColorLabel: (label: ColorLabel | null) => Promise<void>;
  onBulkRerender: () => Promise<void>;
  onBatchRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAddToCollection: (collectionId: number, fileIds: number[]) => Promise<void> | void;
  onRemoveFromCollection: (collectionId: number, fileIds: number[]) => Promise<void> | void;
  onCreateCollection: (name: string) => Promise<CollectionRecord | null>;
}

type SubModal =
  | { kind: 'none' }
  | { kind: 'add-tag' }
  | { kind: 'remove-tag' }
  | { kind: 'new-collection' };

/**
 * Right-click context menu over the thumbnail grid. Acts on the current
 * multi-selection (the caller decides whether right-clicking selects the
 * target tile or leaves the selection alone).
 *
 * Positioning: a 1px target div is fixed at the click coordinates and the
 * Mantine Menu anchors to it. Click-outside / Escape close behavior is
 * provided by Mantine; we don't need to wire it ourselves.
 */
export function ThumbContextMenu(props: Props) {
  const {
    opened,
    x,
    y,
    onClose,
    libraryId,
    selectedFiles,
    primaryFile,
    onOpenPreferences,
    allTags,
    collections,
    activeCollectionId,
    onBulkAddTag,
    onBulkRemoveTag,
    onBulkSetOrientation,
    onBulkSetRating,
    onBulkSetColorLabel,
    onBulkRerender,
    onBatchRename,
    onDuplicate,
    onDelete,
    onAddToCollection,
    onRemoveFromCollection,
    onCreateCollection
  } = props;

  const fileIds = useMemo(() => selectedFiles.map((f) => f.id), [selectedFiles]);
  const [modal, setModal] = useState<SubModal>({ kind: 'none' });
  const activeCollection =
    activeCollectionId != null
      ? collections.find((c) => c.id === activeCollectionId) ?? null
      : null;

  // Aggregate tags applied to the selection so "Remove tag" knows what to offer.
  const [appliedTags, setAppliedTags] = useState<TagRecord[]>([]);
  const refToken = useRef(0);
  // External apps registered for the primary file's extension. Refreshed each
  // time the menu opens so newly-added apps appear without reload.
  const [externalApps, setExternalApps] = useState<ExternalAppRegistration[]>([]);

  useEffect(() => {
    if (!opened || !primaryFile) {
      setExternalApps([]);
      return;
    }
    void ipc.listExternalApps().then((all) => {
      const ext = primaryFile.ext.toLowerCase();
      setExternalApps(
        all
          .filter((a) => a.extensions.length === 0 || a.extensions.includes(ext))
          .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      );
    });
  }, [opened, primaryFile]);

  const openWith = useCallback(
    (appId: string | null, profileId: string | null = null) => {
      if (!primaryFile) return;
      void ipc.openWithExternalApp(libraryId, primaryFile.id, appId, profileId);
      onClose();
    },
    [libraryId, primaryFile, onClose]
  );

  const reveal = useCallback(() => {
    if (!primaryFile) return;
    void ipc.revealFile(libraryId, primaryFile.id);
    onClose();
  }, [libraryId, primaryFile, onClose]);

  const isSingleSelection = selectedFiles.length === 1 && primaryFile != null;

  useEffect(() => {
    if (modal.kind !== 'remove-tag') return;
    const token = ++refToken.current;
    // One batched IPC instead of a round trip per selected file.
    void ipc.listTagsForFiles(libraryId, fileIds).then((results) => {
      if (token !== refToken.current) return;
      setAppliedTags(results.map((t) => ({ id: t.id, name: t.name, parentId: t.parentId })));
    });
  }, [modal.kind, fileIds, libraryId]);

  const close = () => {
    setModal({ kind: 'none' });
    onClose();
  };

  return (
    <>
      <Menu
        opened={opened}
        onChange={(open) => {
          if (!open) onClose();
        }}
        position="bottom-start"
        withinPortal
        shadow="md"
        width={240}
        closeOnItemClick={false}
      >
        <Menu.Target>
          <div
            style={{
              position: 'fixed',
              top: y,
              left: x,
              width: 1,
              height: 1,
              pointerEvents: 'none'
            }}
          />
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>
            {selectedFiles.length} file{selectedFiles.length === 1 ? '' : 's'} selected
          </Menu.Label>

          {isSingleSelection && (
            <>
              <Menu.Item
                leftSection={<IconExternalLink size={14} />}
                onClick={() => openWith(null)}
              >
                Open with default app
              </Menu.Item>
              {externalApps.map((app) => {
                const profiles = app.profiles ?? [];
                if (profiles.length === 0) {
                  return (
                    <Menu.Item
                      key={app.id}
                      leftSection={<IconAppWindow size={14} />}
                      onClick={() => openWith(app.id)}
                    >
                      Open in {app.name}
                    </Menu.Item>
                  );
                }
                // App has profiles — render each as its own item plus a
                // "(no profile)" fallback. Mantine Menus don't nest natively;
                // a flat sub-list is fine since we already have section headers.
                return (
                  <div key={app.id}>
                    <Menu.Label>Open in {app.name}</Menu.Label>
                    <Menu.Item
                      leftSection={<IconAppWindow size={14} />}
                      onClick={() => openWith(app.id, null)}
                    >
                      No profile
                    </Menu.Item>
                    {profiles.map((p) => (
                      <Menu.Item
                        key={p.id}
                        leftSection={<IconAppWindow size={14} />}
                        onClick={() => openWith(app.id, p.id)}
                      >
                        {p.name}
                      </Menu.Item>
                    ))}
                  </div>
                );
              })}
              <Menu.Item
                leftSection={<IconAppWindow size={14} />}
                onClick={() => {
                  onClose();
                  onOpenPreferences();
                }}
              >
                Configure external apps…
              </Menu.Item>
              <Menu.Item
                leftSection={<IconFolderOpen size={14} />}
                onClick={reveal}
              >
                Reveal in Finder
              </Menu.Item>
              <Menu.Divider />
            </>
          )}

          <Menu.Item
            leftSection={<IconTag size={14} />}
            onClick={() => setModal({ kind: 'add-tag' })}
          >
            Add tag…
          </Menu.Item>
          <Menu.Item
            leftSection={<IconTagOff size={14} />}
            onClick={() => setModal({ kind: 'remove-tag' })}
          >
            Remove tag…
          </Menu.Item>

          <Menu.Divider />
          <Menu.Label>Rating</Menu.Label>
          <div style={{ padding: '2px 8px 6px' }}>
            <Group gap={4} wrap="nowrap">
              {[1, 2, 3, 4, 5].map((n) => (
                <UnstyledButton
                  key={n}
                  onClick={() => {
                    void onBulkSetRating(n);
                    onClose();
                  }}
                  style={{
                    padding: '4px 6px',
                    borderRadius: 4,
                    border: '1px solid var(--mantine-color-dark-4)',
                    background: 'var(--mantine-color-dark-6)'
                  }}
                  aria-label={`Rate ${n}`}
                >
                  <IconStarFilled size={12} color="var(--mantine-color-yellow-5)" />
                  <Text component="span" size="xs" ml={4}>
                    {n}
                  </Text>
                </UnstyledButton>
              ))}
              <UnstyledButton
                onClick={() => {
                  void onBulkSetRating(0);
                  onClose();
                }}
                style={{
                  padding: '4px 6px',
                  borderRadius: 4,
                  border: '1px solid var(--mantine-color-dark-4)',
                  background: 'var(--mantine-color-dark-6)'
                }}
                aria-label="Clear rating"
              >
                <IconStarOff size={12} />
              </UnstyledButton>
            </Group>
          </div>

          <Menu.Label>Color label</Menu.Label>
          <div style={{ padding: '2px 8px 6px' }}>
            <Group gap={6} wrap="nowrap">
              {COLOR_LABELS.map((c) => (
                <UnstyledButton
                  key={c}
                  onClick={() => {
                    void onBulkSetColorLabel(c);
                    onClose();
                  }}
                  aria-label={`${c} label`}
                  style={{ padding: 2 }}
                >
                  <IconCircleFilled size={16} color={COLOR_LABEL_HEX[c]} />
                </UnstyledButton>
              ))}
              <UnstyledButton
                onClick={() => {
                  void onBulkSetColorLabel(null);
                  onClose();
                }}
                aria-label="Clear color label"
                style={{ padding: 2 }}
              >
                <IconCircleX size={16} color="var(--mantine-color-gray-5)" />
              </UnstyledButton>
            </Group>
          </div>

          <Menu.Divider />
          <Menu.Label>Up axis</Menu.Label>
          <div style={{ padding: '2px 8px 6px' }}>
            <Group gap={4} wrap="wrap">
              {UP_AXIS_OPTIONS.map((o) => (
                <UnstyledButton
                  key={o.value}
                  onClick={() => {
                    void onBulkSetOrientation({ upAxis: o.value as UpAxis, yaw: 0 });
                    onClose();
                  }}
                  style={{
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontFamily: 'var(--mantine-font-family-monospace, monospace)',
                    border: '1px solid var(--mantine-color-dark-4)',
                    background: 'var(--mantine-color-dark-6)'
                  }}
                >
                  {o.label}
                </UnstyledButton>
              ))}
            </Group>
          </div>
          <Menu.Item
            leftSection={<IconRotateClockwise size={14} />}
            onClick={() => {
              void onBulkSetOrientation(null);
              onClose();
            }}
          >
            Reset orientation to default
          </Menu.Item>

          <Menu.Divider />
          <Menu.Item
            leftSection={<IconRefresh size={14} />}
            onClick={() => {
              void onBulkRerender();
              onClose();
            }}
          >
            Re-render thumbnails
          </Menu.Item>
          <Menu.Item
            leftSection={<IconEdit size={14} />}
            onClick={() => {
              onClose();
              onBatchRename();
            }}
          >
            Rename…
          </Menu.Item>
          {isSingleSelection && (
            <Menu.Item
              leftSection={<IconCopy size={14} />}
              onClick={() => {
                onClose();
                onDuplicate();
              }}
            >
              Duplicate
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconTrash size={14} />}
            color="red"
            onClick={() => {
              onClose();
              onDelete();
            }}
          >
            Move to Trash…
          </Menu.Item>

          <Menu.Divider />
          <Menu.Label>Add to collection</Menu.Label>
          {collections.length === 0 && (
            <Menu.Item disabled>
              <Text size="xs" c="dimmed">
                No collections yet
              </Text>
            </Menu.Item>
          )}
          {collections.map((c) => (
            <Menu.Item
              key={c.id}
              leftSection={<IconFolders size={14} />}
              onClick={() => {
                void onAddToCollection(c.id, fileIds);
                onClose();
              }}
            >
              {c.name}
            </Menu.Item>
          ))}
          <Menu.Item
            leftSection={<IconPlus size={14} />}
            onClick={() => setModal({ kind: 'new-collection' })}
          >
            New collection…
          </Menu.Item>

          {activeCollection && (
            <>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconCircleMinus size={14} />}
                onClick={() => {
                  void onRemoveFromCollection(activeCollection.id, fileIds);
                  onClose();
                }}
              >
                Remove from "{activeCollection.name}"
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>

      <AddTagModal
        opened={modal.kind === 'add-tag'}
        allTags={allTags}
        fileCount={selectedFiles.length}
        onCancel={close}
        onConfirm={async (name) => {
          await onBulkAddTag(name);
          close();
        }}
      />

      <RemoveTagModal
        opened={modal.kind === 'remove-tag'}
        appliedTags={appliedTags}
        onCancel={close}
        onConfirm={async (tagId) => {
          await onBulkRemoveTag(tagId);
          close();
        }}
      />

      <NamePromptModal
        opened={modal.kind === 'new-collection'}
        title="New collection"
        confirmLabel="Create & add"
        placeholder="e.g. Tuesday batch"
        confirmIcon={<IconFolderPlus size={14} />}
        onCancel={close}
        onConfirm={async (name) => {
          const created = await onCreateCollection(name);
          if (created) await onAddToCollection(created.id, fileIds);
          close();
        }}
      />
    </>
  );
}
function AddTagModal({
  opened,
  allTags,
  fileCount,
  onCancel,
  onConfirm
}: {
  opened: boolean;
  allTags: TagWithCount[];
  fileCount: number;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (opened) setValue('');
  }, [opened]);

  const suggestions = useMemo(() => allTags.map((t) => t.name), [allTags]);
  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;

  return (
    <Modal opened={opened} onClose={onCancel} title="Add tag" centered size="sm">
      <Stack gap="md">
        <Autocomplete
          label={`Tag to add to ${fileCount} file${fileCount === 1 ? '' : 's'}`}
          placeholder="Existing or new tag name"
          value={value}
          onChange={setValue}
          data={suggestions}
          data-autofocus
          onKeyDown={(e) => {
            // With a dropdown option highlighted, Enter picks the option
            // (filling the input); a second Enter confirms. Submitting the
            // typed prefix here would tag with the wrong name.
            if (e.key === 'Enter' && canSubmit && !hasActiveComboboxOption(e)) {
              void onConfirm(trimmed);
            }
          }}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void onConfirm(trimmed)}>
            Add tag
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function RemoveTagModal({
  opened,
  appliedTags,
  onCancel,
  onConfirm
}: {
  opened: boolean;
  appliedTags: TagRecord[];
  onCancel: () => void;
  onConfirm: (tagId: number) => Promise<void> | void;
}) {
  return (
    <Modal opened={opened} onClose={onCancel} title="Remove tag" centered size="sm">
      <Stack gap="md">
        {appliedTags.length === 0 ? (
          <Text size="sm" c="dimmed">
            None of the selected files have any tags.
          </Text>
        ) : (
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              Click a tag to remove it from every selected file.
            </Text>
            {appliedTags.map((t) => (
              <UnstyledButton
                key={t.id}
                onClick={() => void onConfirm(t.id)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 4,
                  background: 'var(--mantine-color-dark-6)',
                  border: '1px solid var(--mantine-color-dark-4)'
                }}
              >
                <Group gap={6} wrap="nowrap">
                  <IconHash size={12} />
                  <Text size="sm">{t.name}</Text>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
