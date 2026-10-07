import { useEffect, useMemo, useRef, useState } from 'react';
import { Autocomplete, Group, Pill, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { TagRecord, TagWithCount } from '@shared/types';
import { ipc } from '../ipc-client';
import { hasActiveComboboxOption } from '../util/combobox';

interface Props {
  libraryId: string;
  fileId: number;
  /** Latest known list of all tags in the library, for autocomplete. */
  allTags: TagWithCount[];
  /** Bumped externally when a tags-changed event arrives for this file. */
  refreshKey: number;
}

export function TagEditor({ libraryId, fileId, allTags, refreshKey }: Props) {
  const [fileTags, setFileTags] = useState<TagRecord[]>([]);
  const [draft, setDraft] = useState('');
  // refToken protects against an old in-flight load racing a newer file selection.
  const refToken = useRef(0);

  useEffect(() => {
    const token = ++refToken.current;
    void ipc.listTagsForFile(libraryId, fileId).then((tags) => {
      if (token === refToken.current) setFileTags(tags);
    });
  }, [libraryId, fileId, refreshKey]);

  const fileTagIds = useMemo(() => new Set(fileTags.map((t) => t.id)), [fileTags]);
  const suggestions = useMemo(
    () => allTags.filter((t) => !fileTagIds.has(t.id)).map((t) => t.name),
    [allTags, fileTagIds]
  );

  const submit = async (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    try {
      await ipc.addTagToFile(libraryId, fileId, name);
      setDraft('');
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Add tag failed',
        message: (err as Error).message
      });
    }
  };

  const remove = async (tagId: number) => {
    await ipc.removeTagFromFile(libraryId, fileId, tagId);
  };

  return (
    <Stack gap={6}>
      <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
        Tags
      </Text>
      <Group gap={4} wrap="wrap">
        {fileTags.length === 0 && (
          <Text size="xs" c="dimmed">
            No tags yet
          </Text>
        )}
        {fileTags.map((tag) => (
          <Pill
            key={tag.id}
            size="sm"
            withRemoveButton
            onRemove={() => void remove(tag.id)}
          >
            {tag.name}
          </Pill>
        ))}
      </Group>
      <Autocomplete
        size="xs"
        placeholder="Add tag…"
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
