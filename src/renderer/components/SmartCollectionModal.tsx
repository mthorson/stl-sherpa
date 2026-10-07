import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Chip,
  Group,
  Modal,
  MultiSelect,
  SegmentedControl,
  Stack,
  Text,
  TextInput
} from '@mantine/core';
import { IconCircleFilled, IconStarFilled } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { CollectionRecord, TagWithCount } from '@shared/types';
import {
  COLOR_LABELS,
  COLOR_LABEL_HEX,
  type ColorLabel
} from '@shared/ratings';
import { SUPPORTED_EXTENSIONS, type SupportedExtension } from '@shared/formats';
import { emptySmartQuery, type SmartQuery } from '@shared/smart-query';
import { ipc } from '../ipc-client';

interface Props {
  opened: boolean;
  /** When set, the modal edits the existing smart collection in place. */
  existing: CollectionRecord | null;
  libraryId: string | null;
  allTags: TagWithCount[];
  onClose: () => void;
  onSaved: (collection: CollectionRecord) => void;
}

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * Modal for creating or editing a Smart Collection. All filter widgets feed
 * a single SmartQuery state; a debounced live preview shows the match count.
 */
export function SmartCollectionModal({
  opened,
  existing,
  libraryId,
  allTags,
  onClose,
  onSaved
}: Props) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState<SmartQuery>(emptySmartQuery());
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const previewRequestRef = useRef(0);

  // Seed form from `existing` (or fresh when creating) every time the modal opens.
  useEffect(() => {
    if (!opened) return;
    if (existing) {
      setName(existing.name);
      setQuery(existing.smartQuery ?? emptySmartQuery());
    } else {
      setName('');
      setQuery(emptySmartQuery());
    }
  }, [opened, existing]);

  // Live preview count — debounced so each keystroke doesn't hit the DB.
  useEffect(() => {
    if (!opened || !libraryId) return;
    const request = ++previewRequestRef.current;
    const t = setTimeout(async () => {
      try {
        const rows = await ipc.queryFiles({
          libraryId,
          query: query.search?.trim() || undefined,
          extensions: query.extensions && query.extensions.length > 0 ? query.extensions : undefined,
          tagIds: query.tagIds && query.tagIds.length > 0 ? query.tagIds : undefined,
          minRating: query.minRating && query.minRating > 0 ? query.minRating : undefined,
          colorLabels: query.colorLabels && query.colorLabels.length > 0 ? query.colorLabels : undefined,
          limit: 1000
        });
        if (request === previewRequestRef.current) setMatchCount(rows.length);
      } catch {
        if (request === previewRequestRef.current) setMatchCount(null);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      if (request === previewRequestRef.current) previewRequestRef.current += 1;
    };
  }, [opened, libraryId, query]);

  const tagOptions = useMemo(
    () => allTags.map((t) => ({ value: String(t.id), label: t.name })),
    [allTags]
  );

  const submit = async () => {
    if (!libraryId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      notifications.show({
        color: 'red',
        title: 'Needs a name',
        message: 'Give this collection a name first.'
      });
      return;
    }
    setSubmitting(true);
    try {
      const saved = existing
        ? await ipc.updateSmartQuery(libraryId, existing.id, query)
        : await ipc.createSmartCollection(libraryId, trimmed, query);
      // For edit path, we still need to rename if the user changed it.
      if (existing && saved && trimmed !== existing.name) {
        const renamed = await ipc.renameCollection(libraryId, existing.id, trimmed);
        if (renamed) onSaved(renamed);
        else if (saved) onSaved(saved);
      } else if (saved) {
        onSaved(saved);
      }
      onClose();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: "Couldn't save smart collection",
        message: (err as Error).message
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={existing ? 'Edit smart collection' : 'New smart collection'}
      centered
      size="md"
    >
      <Stack gap="md">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          data-autofocus
        />

        <TextInput
          label="Search (filename, tags, metadata)"
          placeholder="Optional"
          value={query.search ?? ''}
          onChange={(e) => setQuery({ ...query, search: e.currentTarget.value })}
        />

        <Stack gap={4}>
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            Extensions
          </Text>
          <Group gap={4} wrap="wrap">
            {SUPPORTED_EXTENSIONS.map((ext) => {
              const active = query.extensions?.includes(ext) ?? false;
              return (
                <Chip
                  key={ext}
                  checked={active}
                  size="xs"
                  onChange={(checked) => {
                    const cur = new Set<SupportedExtension>(
                      (query.extensions ?? []) as SupportedExtension[]
                    );
                    if (checked) cur.add(ext);
                    else cur.delete(ext);
                    setQuery({ ...query, extensions: [...cur] });
                  }}
                >
                  .{ext}
                </Chip>
              );
            })}
          </Group>
        </Stack>

        <MultiSelect
          label="Has all tags"
          placeholder="Pick tags"
          value={query.tagIds?.map(String) ?? []}
          onChange={(values) => setQuery({ ...query, tagIds: values.map((v) => Number(v)) })}
          data={tagOptions}
          searchable
          clearable
          comboboxProps={{ withinPortal: true }}
        />

        <Stack gap={4}>
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            Min rating
          </Text>
          <SegmentedControl
            size="xs"
            value={String(query.minRating ?? 0)}
            onChange={(v) => setQuery({ ...query, minRating: Number(v) })}
            data={[
              { value: '0', label: 'Any' },
              { value: '1', label: '1+' },
              { value: '2', label: '2+' },
              { value: '3', label: '3+' },
              { value: '4', label: '4+' },
              { value: '5', label: '5' }
            ]}
          />
        </Stack>

        <Stack gap={4}>
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            Color labels
          </Text>
          <Group gap={6}>
            {COLOR_LABELS.map((c) => {
              const active = query.colorLabels?.includes(c) ?? false;
              return (
                <Chip
                  key={c}
                  checked={active}
                  size="xs"
                  onChange={(checked) => {
                    const cur = new Set<ColorLabel>(query.colorLabels ?? []);
                    if (checked) cur.add(c);
                    else cur.delete(c);
                    setQuery({ ...query, colorLabels: [...cur] });
                  }}
                  icon={<IconCircleFilled size={10} color={COLOR_LABEL_HEX[c]} />}
                >
                  {c}
                </Chip>
              );
            })}
          </Group>
        </Stack>

        <Group justify="space-between">
          <Badge
            variant="light"
            color="indigo"
            leftSection={<IconStarFilled size={10} />}
          >
            {matchCount == null
              ? '…'
              : matchCount >= 1000
                ? '1000+ matches'
                : `${matchCount} match${matchCount === 1 ? '' : 'es'}`}
          </Badge>
          <Group gap="sm">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={submitting} onClick={() => void submit()}>
              {existing ? 'Save' : 'Create'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
