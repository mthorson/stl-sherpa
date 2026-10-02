import { useEffect, useMemo, useRef, useState } from 'react';
import { Autocomplete, Group, Pill, Stack, Text, Tooltip } from '@mantine/core';
import type { TagWithCount } from '@shared/types';
import { ipc } from '../ipc-client';
import { hasActiveComboboxOption } from '../util/combobox';

interface Props {
  libraryId: string;
  fileIds: number[];
  /** Latest known list of all tags in the library, for autocomplete. */
  allTags: TagWithCount[];
  /** Bumped externally when a tags-changed event arrives so we re-fetch counts. */
  refreshKey: number;
  onBulkAddTag: (tagName: string) => Promise<void>;
  onBulkRemoveTag: (tagId: number) => Promise<void>;
}

interface AggregatedTag {
  id: number;
  name: string;
  /** How many of the selected files carry this tag. */
  count: number;
}

/**
 * Tag editor for a multi-selection. Shows tags grouped into "On all" (present
 * on every selected file) and "On some" (present on at least one but not all).
 * Add applies to every selected file; remove from the "On all" group removes
 * from every selected file.
 */
export function BulkTagEditor({
  libraryId,
  fileIds,
  allTags,
  refreshKey,
  onBulkAddTag,
  onBulkRemoveTag
}: Props) {
  const [tags, setTags] = useState<AggregatedTag[]>([]);
  const [draft, setDraft] = useState('');
  const refToken = useRef(0);

  // Re-aggregate whenever the selection changes or a tags-changed event lands.
  // One batched IPC — main counts per tag across the selection in SQL.
  useEffect(() => {
    const token = ++refToken.current;
    if (fileIds.length === 0) {
      setTags([]);
      return;
    }
    void ipc.listTagsForFiles(libraryId, fileIds).then((results) => {
      if (token !== refToken.current) return;
      setTags(results.map((t) => ({ id: t.id, name: t.name, count: t.fileCount })));
    });
  }, [libraryId, fileIds, refreshKey]);

  const total = fileIds.length;
  const onAll = useMemo(() => tags.filter((t) => t.count === total), [tags, total]);
  const onSome = useMemo(() => tags.filter((t) => t.count < total), [tags, total]);

  const presentNames = useMemo(() => new Set(tags.map((t) => t.name.toLowerCase())), [tags]);
  const suggestions = useMemo(
    () => allTags.filter((t) => !presentNames.has(t.name.toLowerCase())).map((t) => t.name),
    [allTags, presentNames]
  );

  const submit = async (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    await onBulkAddTag(name);
    setDraft('');
  };

  return (
    <Stack gap={6}>
      <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
        Tags
      </Text>
      {tags.length === 0 && (
        <Text size="xs" c="dimmed">
          No tags on any selected file.
        </Text>
      )}
      {onAll.length > 0 && (
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            On all
          </Text>
          <Group gap={4} wrap="wrap">
            {onAll.map((t) => (
              <Pill
                key={t.id}
                size="sm"
                withRemoveButton
                onRemove={() => void onBulkRemoveTag(t.id)}
              >
                {t.name}
              </Pill>
            ))}
          </Group>
        </Stack>
      )}
      {onSome.length > 0 && (
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            On some
          </Text>
          <Group gap={4} wrap="wrap">
            {onSome.map((t) => (
              <Tooltip
                key={t.id}
                label={`On ${t.count} of ${total}. Click to apply to all.`}
                withinPortal
              >
                <Pill
                  size="sm"
                  withRemoveButton
                  onRemove={() => void onBulkRemoveTag(t.id)}
                  onClick={() => void onBulkAddTag(t.name)}
                  style={{ cursor: 'pointer', opacity: 0.7 }}
                >
                  {t.name} · {t.count}/{total}
                </Pill>
              </Tooltip>
            ))}
          </Group>
        </Stack>
      )}
      <Autocomplete
        size="xs"
        placeholder={`Add tag to all ${total} files…`}
        value={draft}
        onChange={setDraft}
        data={suggestions}
        onOptionSubmit={(value) => void submit(value)}
        onKeyDown={(e) => {
          // With a dropdown option highlighted, Enter belongs to Mantine's
          // onOptionSubmit; submitting the typed prefix too would create
          // two tags.
          if (e.key === 'Enter' && !hasActiveComboboxOption(e)) {
            e.preventDefault();
            void submit(draft);
          }
        }}
      />
    </Stack>
  );
}
