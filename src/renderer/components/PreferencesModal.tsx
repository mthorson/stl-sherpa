import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAppWindow,
  IconBox,
  IconCoffee,
  IconDatabase,
  IconPlus,
  IconRuler,
  IconSparkles,
  IconTrash,
  IconWifi
} from '@tabler/icons-react';
import { v4 as uuid } from 'uuid';
import type {
  ExternalAppRegistration,
  PreferencesFile,
  PrintBed,
  Unit
} from '@shared/preferences';
import { SUPPORTED_EXTENSIONS } from '@shared/formats';
import {
  DEFAULT_RENDER_QUALITY,
  RENDER_QUALITY_PRESETS,
  getRenderQualityPreset,
  type RenderQuality
} from '@shared/render-quality';
import { ipc } from '../ipc-client';
import { savePreferences, usePreferences } from '../util/use-preferences';

interface Props {
  opened: boolean;
  onClose: () => void;
  /** Active library id — used for cache management actions. */
  libraryId: string | null;
}

/**
 * Tabbed settings modal. Each tab is a self-contained section that reads
 * from the live prefs and writes back via savePreferences (which broadcasts
 * to every usePreferences subscriber).
 */
export function PreferencesModal({ opened, onClose, libraryId }: Props) {
  const { prefs, reload } = usePreferences();

  useEffect(() => {
    if (opened) void reload();
  }, [opened, reload]);

  if (!prefs) return null;

  return (
    <Modal opened={opened} onClose={onClose} title="Preferences" centered size="lg">
      <Tabs defaultValue="apps" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="apps" leftSection={<IconAppWindow size={14} />}>
            External apps
          </Tabs.Tab>
          <Tabs.Tab value="units" leftSection={<IconRuler size={14} />}>
            Units
          </Tabs.Tab>
          <Tabs.Tab value="beds" leftSection={<IconBox size={14} />}>
            Print beds
          </Tabs.Tab>
          <Tabs.Tab value="watcher" leftSection={<IconWifi size={14} />}>
            Watcher
          </Tabs.Tab>
          <Tabs.Tab value="quality" leftSection={<IconSparkles size={14} />}>
            3D Quality
          </Tabs.Tab>
          <Tabs.Tab value="cache" leftSection={<IconDatabase size={14} />}>
            Cache
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="apps" pt="md">
          <ExternalAppsSection prefs={prefs} onChanged={reload} />
        </Tabs.Panel>
        <Tabs.Panel value="units" pt="md">
          <UnitsSection prefs={prefs} />
        </Tabs.Panel>
        <Tabs.Panel value="beds" pt="md">
          <PrintBedsSection prefs={prefs} />
        </Tabs.Panel>
        <Tabs.Panel value="watcher" pt="md">
          <WatcherSection prefs={prefs} />
        </Tabs.Panel>
        <Tabs.Panel value="quality" pt="md">
          <RenderQualitySection prefs={prefs} />
        </Tabs.Panel>
        <Tabs.Panel value="cache" pt="md">
          <CacheSection libraryId={libraryId} />
        </Tabs.Panel>
      </Tabs>
      <Divider mt="md" mb="sm" />
      <Group justify="center">
        <Button
          variant="subtle"
          size="xs"
          leftSection={<IconCoffee size={14} />}
          component="a"
          href="https://buymeacoffee.com/thorson"
          target="_blank"
          rel="noreferrer"
        >
          Support meshFlask — Buy me a coffee
        </Button>
      </Group>
    </Modal>
  );
}

function UnitsSection({ prefs }: { prefs: PreferencesFile }) {
  const [unit, setUnit] = useState<Unit>(prefs.unit ?? 'mm');
  const apply = useCallback(
    async (next: Unit) => {
      setUnit(next);
      await savePreferences({ ...prefs, unit: next });
    },
    [prefs]
  );
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        STL/3MF files don't encode units — this is purely a display preference.
      </Text>
      <SegmentedControl
        value={unit}
        onChange={(v) => void apply(v as Unit)}
        data={[
          { value: 'mm', label: 'Millimeters' },
          { value: 'in', label: 'Inches' }
        ]}
      />
    </Stack>
  );
}

function PrintBedsSection({ prefs }: { prefs: PreferencesFile }) {
  const beds = prefs.printBeds ?? [];
  const [draft, setDraft] = useState({ name: '', x: 220, y: 220, z: 250 });

  const save = useCallback(
    async (next: PrintBed[]) => {
      await savePreferences({ ...prefs, printBeds: next });
    },
    [prefs]
  );

  const add = async () => {
    if (!draft.name.trim()) return;
    const next: PrintBed = {
      id: uuid(),
      name: draft.name.trim(),
      x: draft.x,
      y: draft.y,
      z: draft.z
    };
    await save([...beds, next]);
    setDraft({ name: '', x: 220, y: 220, z: 250 });
  };

  const remove = async (id: string) => {
    await save(beds.filter((b) => b.id !== id));
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Registered printer beds (mm). Models whose bounding box doesn't fit any bed get a warning
        badge in the grid.
      </Text>
      <Stack gap={4}>
        {beds.length === 0 && (
          <Text size="xs" c="dimmed">
            No beds yet. Add one below.
          </Text>
        )}
        {beds.map((b) => (
          <Group
            key={b.id}
            gap="xs"
            wrap="nowrap"
            style={{
              padding: '6px 8px',
              borderRadius: 4,
              background: 'var(--mantine-color-dark-6)'
            }}
          >
            <Text size="sm" fw={500} style={{ flex: 1 }}>
              {b.name}
            </Text>
            <Badge size="xs" variant="default" ff="monospace">
              {b.x} × {b.y} × {b.z}
            </Badge>
            <Tooltip label="Remove bed">
              <ActionIcon
                variant="subtle"
                color="red"
                size="sm"
                onClick={() => void remove(b.id)}
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ))}
      </Stack>
      <Divider my="xs" />
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        Add bed
      </Text>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          size="xs"
          placeholder="Name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
          style={{ flex: 1 }}
        />
        <NumberInput
          size="xs"
          w={70}
          min={1}
          value={draft.x}
          onChange={(v) => setDraft({ ...draft, x: Number(v) || 0 })}
          aria-label="X mm"
        />
        <NumberInput
          size="xs"
          w={70}
          min={1}
          value={draft.y}
          onChange={(v) => setDraft({ ...draft, y: Number(v) || 0 })}
          aria-label="Y mm"
        />
        <NumberInput
          size="xs"
          w={70}
          min={1}
          value={draft.z}
          onChange={(v) => setDraft({ ...draft, z: Number(v) || 0 })}
          aria-label="Z mm"
        />
        <Button size="xs" leftSection={<IconPlus size={12} />} onClick={() => void add()}>
          Add
        </Button>
      </Group>
    </Stack>
  );
}

function WatcherSection({ prefs }: { prefs: PreferencesFile }) {
  const [interval, setIntervalValue] = useState<number>(prefs.nasPollIntervalSec ?? 10);
  const apply = async (next: number) => {
    setIntervalValue(next);
    await savePreferences({ ...prefs, nasPollIntervalSec: next });
  };
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        How often to poll NAS-mounted libraries for filesystem changes (chokidar polling).
        fsevents/inotify don't fire on network mounts so we fall back to polling. Trade-off:
        shorter intervals = more network traffic.
      </Text>
      <NumberInput
        label="NAS poll interval (seconds)"
        value={interval}
        onChange={(v) => void apply(Math.max(1, Math.min(60, Number(v) || 10)))}
        min={1}
        max={60}
        step={1}
      />
      <Text size="xs" c="dimmed">
        Changes take effect when a library re-attaches (restart the app).
      </Text>
    </Stack>
  );
}

function RenderQualitySection({ prefs }: { prefs: PreferencesFile }) {
  const current: RenderQuality = prefs.renderQuality ?? DEFAULT_RENDER_QUALITY;
  const preset = getRenderQualityPreset(current);
  const apply = (next: string) => {
    void savePreferences({ ...prefs, renderQuality: next as RenderQuality });
  };
  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Affects the interactive 3D preview only — background thumbnail rendering
        always uses Low for speed and consistency.
      </Text>
      <SegmentedControl
        fullWidth
        value={current}
        onChange={apply}
        data={RENDER_QUALITY_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
      />
      <Text size="sm">{preset.description}</Text>
      <Stack gap={2}>
        <Text size="xs" c="dimmed">
          Shadows: {preset.shadows.enabled ? `${preset.shadows.filter}, ${preset.shadows.mapSize}px` : 'off'}
        </Text>
        <Text size="xs" c="dimmed">
          Texture anisotropy: {preset.anisotropy}×
        </Text>
        <Text size="xs" c="dimmed">
          Env-map blur: {preset.envMapRoughness}
        </Text>
      </Stack>
      <Text size="xs" c="dimmed">
        Changing quality reloads the active preview.
      </Text>
    </Stack>
  );
}

function CacheSection({ libraryId }: { libraryId: string | null }) {
  const [busy, setBusy] = useState<'rebuild' | 'purge' | null>(null);

  const rebuild = async () => {
    if (!libraryId) return;
    setBusy('rebuild');
    try {
      await ipc.rebuildThumbCache(libraryId);
      notifications.show({
        color: 'green',
        title: 'Cache rebuild queued',
        message: 'Thumbnails will re-render in the background.'
      });
    } finally {
      setBusy(null);
    }
  };

  const purge = async () => {
    if (!libraryId) return;
    setBusy('purge');
    try {
      const result = await ipc.purgeOrphanThumbs(libraryId);
      notifications.show({
        color: 'green',
        title: 'Orphan sidecars purged',
        message: `Removed ${result.removed} file${result.removed === 1 ? '' : 's'}.`
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Manage the per-library thumbnail cache. These actions are scoped to the currently active
        library.
      </Text>
      <Group gap="sm">
        <Button
          variant="default"
          size="xs"
          loading={busy === 'rebuild'}
          disabled={!libraryId}
          onClick={() => void rebuild()}
        >
          Rebuild thumbnail cache
        </Button>
        <Button
          variant="default"
          size="xs"
          loading={busy === 'purge'}
          disabled={!libraryId}
          onClick={() => void purge()}
        >
          Purge orphan sidecars
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Rebuild wipes the `thumbnails` table and re-queues every file. Purge removes sidecar
        PNG/WebP files whose `file_id` no longer exists.
      </Text>
    </Stack>
  );
}

function ExternalAppsSection({
  prefs,
  onChanged
}: {
  prefs: PreferencesFile;
  onChanged: () => Promise<void>;
}) {
  const apps = prefs.externalApps;
  const [adding, setAdding] = useState(false);
  const [extensionsDraft, setExtensionsDraft] = useState('stl,3mf,obj,glb,gltf,ply');

  const addApp = async () => {
    setAdding(true);
    try {
      const exts = extensionsDraft
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      const created = await ipc.addExternalApp(exts);
      if (created) {
        notifications.show({
          color: 'green',
          title: 'External app added',
          message: `${created.name} registered for ${exts.join(', ') || 'all extensions'}`
        });
        await onChanged();
      }
    } finally {
      setAdding(false);
    }
  };

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Apps registered here show up in the right-click "Open with…" submenu.
      </Text>
      <Stack gap={4}>
        {apps.length === 0 && (
          <Text size="xs" c="dimmed">
            No external apps yet.
          </Text>
        )}
        {apps.map((app) => (
          <AppRow key={app.id} app={app} prefs={prefs} onChanged={onChanged} />
        ))}
      </Stack>
      <Divider my="xs" />
      <Text size="xs" fw={600} tt="uppercase" c="dimmed">
        Register a new app
      </Text>
      <TextInput
        size="xs"
        label="Extensions (comma-separated)"
        value={extensionsDraft}
        onChange={(e) => setExtensionsDraft(e.currentTarget.value)}
        placeholder={SUPPORTED_EXTENSIONS.join(', ')}
      />
      <Group justify="flex-end">
        <Button
          size="xs"
          leftSection={<IconPlus size={14} />}
          loading={adding}
          onClick={() => void addApp()}
        >
          Pick app…
        </Button>
      </Group>
    </Stack>
  );
}

function AppRow({
  app,
  prefs,
  onChanged
}: {
  app: ExternalAppRegistration;
  prefs: PreferencesFile;
  onChanged: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [argsTemplate, setArgsTemplate] = useState(app.argsTemplate ?? '');

  const updateApp = async (patch: Partial<ExternalAppRegistration>) => {
    const next: PreferencesFile = {
      ...prefs,
      externalApps: prefs.externalApps.map((a) => (a.id === app.id ? { ...a, ...patch } : a))
    };
    await savePreferences(next);
    await onChanged();
  };

  const addProfile = async () => {
    // For now, just prompt for a path via TextInput-driven add (no file picker
    // dialog inside the modal). User pastes path; common with slicer .ini files.
    const path = window.prompt('Profile file path');
    if (!path) return;
    const name = window.prompt('Profile name', path.split('/').pop() ?? 'Profile') ?? 'Profile';
    const next = [...(app.profiles ?? []), { id: uuid(), name, path }];
    await updateApp({ profiles: next });
  };

  const removeProfile = async (id: string) => {
    await updateApp({ profiles: (app.profiles ?? []).filter((p) => p.id !== id) });
  };

  return (
    <Stack
      gap={4}
      style={{
        padding: '6px 8px',
        borderRadius: 4,
        background: 'var(--mantine-color-dark-6)'
      }}
    >
      <Group gap="xs" wrap="nowrap">
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={500} truncate>
            {app.name}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {app.path}
          </Text>
          <Group gap={4} mt={2} wrap="wrap">
            {app.extensions.length === 0 ? (
              <Badge size="xs" variant="default">
                all
              </Badge>
            ) : (
              app.extensions.map((e) => (
                <Badge key={e} size="xs" variant="default">
                  .{e}
                </Badge>
              ))
            )}
          </Group>
        </Stack>
        <Tooltip label="Default for its extensions">
          <Switch
            size="xs"
            checked={app.isDefault}
            onChange={async (e) => {
              const ext = app.extensions[0];
              if (!ext) return;
              await ipc.setDefaultExternalApp(e.currentTarget.checked ? app.id : '', ext);
              await onChanged();
            }}
          />
        </Tooltip>
        <Button size="compact-xs" variant="subtle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Less' : 'Args + profiles'}
        </Button>
        <Tooltip label="Remove">
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            onClick={async () => {
              await ipc.removeExternalApp(app.id);
              await onChanged();
            }}
            aria-label={`Remove ${app.name}`}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {expanded && (
        <Stack gap={6} mt={6}>
          <TextInput
            size="xs"
            label="CLI args template"
            description="Tokens: {file}, {profile}. Empty = just pass {file}."
            value={argsTemplate}
            placeholder="e.g. --load {profile} {file}"
            onChange={(e) => setArgsTemplate(e.currentTarget.value)}
            onBlur={() => void updateApp({ argsTemplate: argsTemplate || undefined })}
          />
          <Group gap={4} wrap="wrap" align="center">
            <Text size="xs" fw={600} c="dimmed">
              Profiles:
            </Text>
            {(app.profiles ?? []).map((p) => (
              <Badge
                key={p.id}
                size="xs"
                rightSection={
                  <ActionIcon
                    size="xs"
                    variant="transparent"
                    color="red"
                    onClick={() => void removeProfile(p.id)}
                    aria-label={`Remove profile ${p.name}`}
                  >
                    ×
                  </ActionIcon>
                }
              >
                {p.name}
              </Badge>
            ))}
            <Button size="compact-xs" variant="subtle" onClick={() => void addProfile()}>
              + profile
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
