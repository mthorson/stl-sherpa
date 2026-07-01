import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Code,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput
} from '@mantine/core';
import { IconAlertCircle, IconArrowRight } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { BatchRenameItem, FileRecord } from '@shared/types';
import { isInvalidFilename, renderTemplate } from '@shared/rename-template';
import { ipc } from '../ipc-client';

interface Props {
  opened: boolean;
  libraryId: string | null;
  files: FileRecord[];
  onClose: () => void;
}

const DEFAULT_TEMPLATE = '{name}{ext}';

interface PreviewRow {
  file: FileRecord;
  newName: string;
  newRelPath: string;
  warning?: string;
  changed: boolean;
}

/**
 * Batch rename. Shows a live preview table; only commits when
 * every row is collision-free and at least one row actually changes.
 */
export function BatchRenameModal({ opened, libraryId, files, onClose }: Props) {
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (opened) {
      setTemplate(DEFAULT_TEMPLATE);
      setSubmitting(false);
    }
  }, [opened]);

  const rows = useMemo<PreviewRow[]>(() => {
    if (files.length === 0) return [];
    return files.map((file, i) => {
      const newName = renderTemplate(
        { filename: file.filename, ext: file.ext, mtimeMs: file.mtimeMs },
        i,
        files.length,
        template
      );
      const parentDir = file.parentDir;
      const newRelPath = parentDir ? `${parentDir}/${newName}` : newName;
      let warning: string | undefined;
      if (isInvalidFilename(newName)) warning = 'Invalid filename';
      return {
        file,
        newName,
        newRelPath,
        warning,
        changed: newName !== file.filename
      };
    });
  }, [files, template]);

  // Cross-row collision detection — purely informational; the main process
  // re-checks at commit time so this is just early feedback.
  const collisions = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.newRelPath)) dupes.add(r.newRelPath);
      seen.add(r.newRelPath);
    }
    return dupes;
  }, [rows]);

  const anyInvalid = rows.some((r) => r.warning);
  const anyChanged = rows.some((r) => r.changed);
  const anyCollision = collisions.size > 0;
  const canSubmit = anyChanged && !anyInvalid && !anyCollision && !submitting && opened;

  const submit = async () => {
    if (!libraryId || !canSubmit) return;
    setSubmitting(true);
    try {
      const plan: BatchRenameItem[] = rows
        .filter((r) => r.changed)
        .map((r) => ({
          fileId: r.file.id,
          fromRelPath: r.file.relPath,
          toRelPath: r.newRelPath
        }));
      const result = await ipc.batchRename(libraryId, plan);
      if (result.ok) {
        notifications.show({
          color: 'green',
          title: 'Batch rename',
          message: `Renamed ${result.renamed} file${result.renamed === 1 ? '' : 's'}.`
        });
        onClose();
      } else if (result.collisions && result.collisions.length > 0) {
        notifications.show({
          color: 'orange',
          title: 'Rename aborted — collisions',
          message: result.collisions.slice(0, 5).join(', ')
        });
      } else {
        notifications.show({
          color: 'red',
          title: 'Rename failed',
          message: result.error ?? 'Unknown error; changes rolled back.'
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Batch rename" centered size="xl">
      <Stack gap="md">
        <TextInput
          label="Template"
          description={
            <Text size="xs" c="dimmed">
              Tokens:{' '}
              <Code>{'{name}'}</Code> <Code>{'{ext}'}</Code> <Code>{'{counter}'}</Code>{' '}
              <Code>{'{counter:03}'}</Code> <Code>{'{original}'}</Code>{' '}
              <Code>{'{date:YYYY-MM-DD}'}</Code>
            </Text>
          }
          value={template}
          onChange={(e) => setTemplate(e.currentTarget.value)}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) void submit();
          }}
        />

        {anyInvalid && (
          <Alert color="red" icon={<IconAlertCircle size={14} />}>
            One or more generated names are invalid. Fix the template to continue.
          </Alert>
        )}
        {anyCollision && (
          <Alert color="orange" icon={<IconAlertCircle size={14} />}>
            Some files would resolve to the same name. Add a {`{counter}`} token to disambiguate.
          </Alert>
        )}

        <ScrollArea h={300} type="auto">
          <Table withRowBorders={false} verticalSpacing={4} fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Original</Table.Th>
                <Table.Th style={{ width: 24 }}></Table.Th>
                <Table.Th>New</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => {
                const colliding = collisions.has(r.newRelPath);
                return (
                  <Table.Tr key={r.file.id}>
                    <Table.Td style={{ wordBreak: 'break-all' }}>
                      <Text size="xs" c="dimmed">
                        {r.file.filename}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <IconArrowRight size={12} color="var(--mantine-color-dimmed)" />
                    </Table.Td>
                    <Table.Td style={{ wordBreak: 'break-all' }}>
                      <Text
                        size="xs"
                        c={r.warning || colliding ? 'red' : r.changed ? undefined : 'dimmed'}
                        fw={r.changed ? 500 : 400}
                      >
                        {r.newName}
                        {r.warning && ` — ${r.warning}`}
                        {colliding && !r.warning && ' — duplicate target'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} loading={submitting} onClick={() => void submit()}>
            Rename {rows.filter((r) => r.changed).length} file
            {rows.filter((r) => r.changed).length === 1 ? '' : 's'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
