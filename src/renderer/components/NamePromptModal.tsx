import { useEffect, useState } from 'react';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';

interface Props {
  opened: boolean;
  title: string;
  confirmLabel: string;
  /** Pre-filled value for rename flows; omit for create flows. */
  initial?: string;
  label?: string;
  placeholder?: string;
  confirmIcon?: React.ReactNode;
  /** Disable confirm until the name differs from `initial` (rename flows). */
  requireChange?: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void> | void;
}

/**
 * The one name-prompt dialog: a single text input with Enter-to-confirm.
 * Library rename, collection create/rename, and the context menu's "new
 * collection" all render this rather than maintaining drifting copies.
 */
export function NamePromptModal({
  opened,
  title,
  confirmLabel,
  initial = '',
  label = 'Name',
  placeholder,
  confirmIcon,
  requireChange = false,
  onCancel,
  onConfirm
}: Props) {
  const [value, setValue] = useState(initial);

  // Reset the draft each time the modal opens.
  useEffect(() => {
    if (opened) setValue(initial);
  }, [opened, initial]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && (!requireChange || trimmed !== initial);
  const confirm = () => {
    if (canSubmit) void onConfirm(trimmed);
  };

  return (
    <Modal opened={opened} onClose={onCancel} title={title} centered size="sm">
      <Stack gap="md">
        <TextInput
          label={label}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') confirm();
          }}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button leftSection={confirmIcon} disabled={!canSubmit} onClick={confirm}>
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
