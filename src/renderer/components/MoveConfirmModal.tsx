import { Button, Code, Group, Modal, Stack, Text } from '@mantine/core';
import type { FileRecord } from '@shared/types';

interface Props {
  opened: boolean;
  files: FileRecord[];
  toParentDir: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Drag-onto-folder lands here before doing any FS work. Shows the source
 * count and destination path so the user can bail if they aimed wrong.
 */
export function MoveConfirmModal({ opened, files, toParentDir, onCancel, onConfirm }: Props) {
  const dest = toParentDir === '' ? '(library root)' : toParentDir;
  return (
    <Modal opened={opened} onClose={onCancel} centered size="md" title="Move files?">
      <Stack gap="md">
        <Text size="sm">
          Move {files.length} file{files.length === 1 ? '' : 's'} to <Code>{dest}</Code>?
        </Text>
        <Text size="xs" c="dimmed">
          The file{files.length === 1 ? ' is' : 's are'} moved on disk, and the library updates
          automatically.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Move</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
