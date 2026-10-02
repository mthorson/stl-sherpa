import { ActionIcon, Badge, Group, Pill, Text, TextInput, Tooltip } from '@mantine/core';
import { IconSearch, IconX } from '@tabler/icons-react';
import { SUPPORTED_EXTENSIONS, type SupportedExtension } from '@shared/formats';

interface Props {
  query: string;
  onQueryChange: (q: string) => void;
  selectedExtensions: Set<SupportedExtension>;
  onToggleExtension: (ext: SupportedExtension) => void;
  onClearExtensions: () => void;
  /** Active library — drives the inline scope hint so the user can see at
   *  a glance that the search is library-scoped. */
  libraryName: string | null;
}

export function SearchBar({
  query,
  onQueryChange,
  selectedExtensions,
  onToggleExtension,
  onClearExtensions,
  libraryName
}: Props) {
  const hasFilter = selectedExtensions.size > 0;
  const scopeLabel = libraryName ?? 'no library';
  return (
    <Group gap={8} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
      <TextInput
        size="xs"
        placeholder={
          libraryName ? `Search in ${libraryName}…` : 'Search filenames, tags, materials…'
        }
        value={query}
        onChange={(e) => onQueryChange(e.currentTarget.value)}
        leftSection={<IconSearch size={14} />}
        rightSection={
          query ? (
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={() => onQueryChange('')}
              aria-label="Clear search"
            >
              <IconX size={12} />
            </ActionIcon>
          ) : null
        }
        style={{ flex: 1, minWidth: 200, maxWidth: 480 }}
      />
      <Tooltip
        label={`Searching in ${scopeLabel}. Pick a different library in the sidebar to search elsewhere.`}
        withinPortal
      >
        <Badge
          size="sm"
          variant="light"
          color="gray"
          style={{ textTransform: 'none', cursor: 'help', flexShrink: 0, maxWidth: 200 }}
        >
          <Text component="span" size="xs" c="dimmed">
            in&nbsp;
          </Text>
          <Text component="span" size="xs" fw={600} truncate>
            {scopeLabel}
          </Text>
        </Badge>
      </Tooltip>
      <Group gap={4} wrap="nowrap">
        {SUPPORTED_EXTENSIONS.map((ext) => {
          const active = selectedExtensions.has(ext);
          return (
            <Pill
              key={ext}
              size="sm"
              withRemoveButton={active}
              onRemove={() => onToggleExtension(ext)}
              onClick={() => !active && onToggleExtension(ext)}
              style={{
                cursor: 'pointer',
                background: active ? 'var(--mantine-color-indigo-9)' : undefined,
                color: active ? 'var(--mantine-color-white)' : undefined
              }}
            >
              {ext}
            </Pill>
          );
        })}
        {hasFilter && (
          <Tooltip label="Clear extension filter">
            <ActionIcon variant="subtle" size="sm" onClick={onClearExtensions} aria-label="Clear">
              <IconX size={12} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Group>
  );
}
