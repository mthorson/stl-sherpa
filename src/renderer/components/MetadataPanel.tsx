import { useEffect, useMemo, useState } from 'react';
import { Badge, Divider, Group, Stack, Text, Textarea } from '@mantine/core';
import type {
  CollectionRecord,
  CollectionWithCount,
  ColorLabel,
  ExtractedMetadata,
  FileRecord,
  TagWithCount
} from '@shared/types';
import type { FileOrientation } from '@shared/orientation';
import { formatDimension, formatVolume } from '@shared/units';
import {
  DEFAULT_PRINT_COST_PREFS,
  estimateFilamentCost,
  estimateResinCost
} from '@shared/print-cost';
import { TagEditor } from './TagEditor';
import { BulkMetadataPanel } from './BulkMetadataPanel';
import { AddToCollectionMenu } from './AddToCollectionMenu';
import { RatingWidget } from './RatingWidget';
import { ColorLabelWidget } from './ColorLabelWidget';
import { formatBytes, formatDateTime, formatRelativeTime } from '../util/format';
import { usePreferences } from '../util/use-preferences';
import { ipc } from '../ipc-client';

interface Props {
  libraryId: string | null;
  /** The most-recently-clicked file. Drives the single-file detail view. */
  primaryFile: FileRecord | null;
  /** All files in the current selection (>= 1 when primaryFile is non-null). */
  selectedFiles: FileRecord[];
  allTags: TagWithCount[];
  collections: CollectionWithCount[];
  activeCollectionId: number | null;
  tagRefreshKey: number;
  onBulkAddTag: (tagName: string) => Promise<void>;
  onBulkRemoveTag: (tagId: number) => Promise<void>;
  onBulkSetOrientation: (orientation: FileOrientation | null) => Promise<void>;
  onBulkSetRating: (rating: number) => Promise<void>;
  onBulkSetColorLabel: (label: ColorLabel | null) => Promise<void>;
  onBulkRerender: () => Promise<void>;
  onBatchRename: () => void;
  onCompare: () => void;
  onAddToCollection: (collectionId: number, fileIds: number[]) => Promise<void> | void;
  onRemoveFromCollection: (collectionId: number, fileIds: number[]) => Promise<void> | void;
  onCreateCollection: (name: string) => Promise<CollectionRecord | null>;
}

/**
 * Right-pane metadata. Branches by selection size:
 *  - 0 → empty hint
 *  - 1 → per-file detail (size, geometry, tags, "Add to collection")
 *  - >1 → BulkMetadataPanel (tags + bulk orientation + actions)
 */
export function MetadataPanel(props: Props) {
  const {
    libraryId,
    primaryFile,
    selectedFiles,
    allTags,
    collections,
    activeCollectionId,
    tagRefreshKey,
    onAddToCollection,
    onRemoveFromCollection,
    onCreateCollection
  } = props;

  if (!libraryId || selectedFiles.length === 0 || !primaryFile) {
    return (
      <Stack gap="xs" p="md">
        <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
          Metadata
        </Text>
        <Text c="dimmed" size="sm">
          Select a file to view details.
        </Text>
      </Stack>
    );
  }

  if (selectedFiles.length > 1) {
    return (
      <BulkMetadataPanel
        libraryId={libraryId}
        selectedFiles={selectedFiles}
        allTags={allTags}
        collections={collections}
        activeCollectionId={activeCollectionId}
        tagRefreshKey={tagRefreshKey}
        onBulkAddTag={props.onBulkAddTag}
        onBulkRemoveTag={props.onBulkRemoveTag}
        onBulkSetOrientation={props.onBulkSetOrientation}
        onBulkSetRating={props.onBulkSetRating}
        onBulkSetColorLabel={props.onBulkSetColorLabel}
        onBulkRerender={props.onBulkRerender}
        onBatchRename={props.onBatchRename}
        onCompare={props.onCompare}
        onAddToCollection={props.onAddToCollection}
        onRemoveFromCollection={props.onRemoveFromCollection}
        onCreateCollection={props.onCreateCollection}
      />
    );
  }

  return (
    <SingleFilePanel
      libraryId={libraryId}
      file={primaryFile}
      allTags={allTags}
      collections={collections}
      activeCollectionId={activeCollectionId}
      tagRefreshKey={tagRefreshKey}
      onAddToCollection={onAddToCollection}
      onRemoveFromCollection={onRemoveFromCollection}
      onCreateCollection={onCreateCollection}
      onSetRating={(r) => props.onBulkSetRating(r)}
      onSetColorLabel={(l) => props.onBulkSetColorLabel(l)}
    />
  );
}

function SingleFilePanel({
  libraryId,
  file,
  allTags,
  collections,
  activeCollectionId,
  tagRefreshKey,
  onAddToCollection,
  onRemoveFromCollection,
  onCreateCollection,
  onSetRating,
  onSetColorLabel
}: {
  libraryId: string;
  file: FileRecord;
  allTags: TagWithCount[];
  collections: CollectionWithCount[];
  activeCollectionId: number | null;
  tagRefreshKey: number;
  onAddToCollection: (collectionId: number, fileIds: number[]) => Promise<void> | void;
  onRemoveFromCollection: (collectionId: number, fileIds: number[]) => Promise<void> | void;
  onCreateCollection: (name: string) => Promise<CollectionRecord | null>;
  onSetRating: (rating: number) => Promise<void>;
  onSetColorLabel: (label: ColorLabel | null) => Promise<void>;
}) {
  const metadata = useMemo<ExtractedMetadata | null>(() => {
    if (!file.metadataJson) return null;
    try {
      return JSON.parse(file.metadataJson) as ExtractedMetadata;
    } catch {
      return null;
    }
  }, [file.metadataJson]);

  return (
    <Stack gap="sm" p="md" style={{ height: '100%', overflow: 'auto' }}>
      <Group justify="space-between" align="center">
        <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
          Metadata
        </Text>
        <Badge variant="light" size="sm">
          .{file.ext}
        </Badge>
      </Group>

      <div>
        <Text size="sm" fw={600} style={{ wordBreak: 'break-all' }}>
          {file.filename}
        </Text>
        <Text size="xs" c="dimmed" mt={2} style={{ wordBreak: 'break-all' }}>
          {file.relPath}
        </Text>
      </div>

      <Divider />

      <Field label="Size" value={formatBytes(file.sizeBytes)} />
      <Field
        label="Modified"
        value={`${formatRelativeTime(file.mtimeMs)} · ${formatDateTime(file.mtimeMs)}`}
      />

      <Divider />

      <div>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
          Triage
        </Text>
        <Group gap="md" wrap="wrap">
          <RatingWidget value={file.rating} onChange={(r) => void onSetRating(r)} />
          <ColorLabelWidget value={file.colorLabel} onChange={(l) => void onSetColorLabel(l)} />
        </Group>
      </div>

      {metadata && (
        <>
          <Divider />
          <ModelStats metadata={metadata} />
        </>
      )}

      <Divider />

      <TagEditor
        libraryId={libraryId}
        fileId={file.id}
        allTags={allTags}
        refreshKey={tagRefreshKey}
      />

      <Divider />

      <NotesEditor libraryId={libraryId} file={file} />

      <Divider />

      <Group gap={6} wrap="wrap">
        <AddToCollectionMenu
          collections={collections}
          fileIds={[file.id]}
          onAdd={onAddToCollection}
          onCreate={onCreateCollection}
        />
        {activeCollectionId != null && (
          <button
            type="button"
            onClick={() => void onRemoveFromCollection(activeCollectionId, [file.id])}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '4px 10px',
              borderRadius: 4,
              background: 'var(--mantine-color-red-9)',
              color: 'var(--mantine-color-red-1)',
              fontSize: 12,
              fontWeight: 500
            }}
          >
            Remove from collection
          </button>
        )}
      </Group>
    </Stack>
  );
}

/**
 * Debounced notes auto-save. The textarea is uncontrolled-feeling but state
 * lives here; a 400ms debounce flushes via setFileNotes IPC. Re-seeds from
 * `file.notes` when the file changes so switching files doesn't show stale
 * input.
 */
function NotesEditor({ libraryId, file }: { libraryId: string; file: FileRecord }) {
  const [draft, setDraft] = useState(file.notes);

  // Re-seed when the user picks a different file.
  useEffect(() => {
    setDraft(file.notes);
  }, [file.id, file.notes]);

  // Debounced save on edits.
  useEffect(() => {
    if (draft === file.notes) return;
    const t = setTimeout(() => {
      void ipc.setFileNotes(libraryId, file.id, draft);
    }, 400);
    return () => clearTimeout(t);
  }, [draft, file.id, file.notes, libraryId]);

  return (
    <Stack gap={4}>
      <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
        Notes
      </Text>
      <Textarea
        size="xs"
        autosize
        minRows={2}
        maxRows={8}
        placeholder="Needs supports, scale 110%, etc."
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
      />
    </Stack>
  );
}

function ModelStats({ metadata }: { metadata: ExtractedMetadata }) {
  const { prefs } = usePreferences();
  const unit = prefs?.unit ?? 'mm';
  const costPrefs = prefs?.printCost ?? DEFAULT_PRINT_COST_PREFS;
  const isEmbedded = metadata.thumbSource === '3mf-embedded';
  const isZero =
    metadata.boundingBox.size[0] === 0 &&
    metadata.boundingBox.size[1] === 0 &&
    metadata.boundingBox.size[2] === 0;
  const sizeStr = isZero
    ? null
    : metadata.boundingBox.size.map((n) => formatDimension(n, unit)).join(' × ');
  const bboxVolumeStr = isZero
    ? null
    : formatVolume(
        metadata.boundingBox.size[0] * metadata.boundingBox.size[1] * metadata.boundingBox.size[2],
        unit
      );
  const meshVolumeMm3 = metadata.meshVolumeMm3;
  const meshVolumeStr =
    meshVolumeMm3 != null && meshVolumeMm3 > 0 ? formatVolume(meshVolumeMm3, unit) : null;
  const filamentCost =
    meshVolumeMm3 != null && meshVolumeMm3 > 0
      ? estimateFilamentCost(meshVolumeMm3, costPrefs)
      : null;
  const resinCost =
    meshVolumeMm3 != null && meshVolumeMm3 > 0
      ? estimateResinCost(meshVolumeMm3, costPrefs)
      : null;

  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
          Geometry
        </Text>
        {isEmbedded && (
          <Badge size="xs" variant="light" color="orange">
            slicer thumb
          </Badge>
        )}
      </Group>
      {isEmbedded ? (
        <Text size="xs" c="dimmed">
          Mesh metadata is skipped when a slicer-embedded thumbnail is used. Capture the in-UI view
          to populate.
        </Text>
      ) : (
        <>
          <Field label="Vertices" value={metadata.vertexCount.toLocaleString()} />
          <Field label="Triangles" value={metadata.triangleCount.toLocaleString()} />
          <Field
            label="Meshes"
            value={`${metadata.meshCount} (${metadata.materialCount} material${
              metadata.materialCount === 1 ? '' : 's'
            })`}
          />
          {sizeStr && <Field label="Bounding box" value={sizeStr} />}
          {bboxVolumeStr && <Field label="Bounding box vol." value={bboxVolumeStr} />}
          {meshVolumeStr && <Field label="Mesh volume" value={meshVolumeStr} />}
          {metadata.validation && (
            <Field
              label="Watertight"
              value={
                metadata.validation.isWatertight === true
                  ? 'yes'
                  : metadata.validation.isWatertight === false
                    ? `no${metadata.validation.degenerateTriangles > 0 ? ` (${metadata.validation.degenerateTriangles} degenerate)` : ''}`
                    : `n/a (${metadata.validation.skipped})`
              }
            />
          )}
          {metadata.textures && metadata.textures.length > 0 && (
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Textures
              </Text>
              <Stack gap={2} mt={2}>
                {metadata.textures.slice(0, 12).map((t, i) => (
                  <Group key={i} gap={6} wrap="nowrap">
                    <Badge size="xs" variant="default">
                      {t.role}
                    </Badge>
                    <Text size="xs" truncate style={{ flex: 1 }}>
                      {t.name}
                    </Text>
                  </Group>
                ))}
                {metadata.textures.length > 12 && (
                  <Text size="xs" c="dimmed">
                    +{metadata.textures.length - 12} more
                  </Text>
                )}
              </Stack>
            </div>
          )}
          {metadata.materialNames.length > 0 && (
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Materials
              </Text>
              <Group gap={4} mt={2}>
                {metadata.materialNames.slice(0, 6).map((n) => (
                  <Badge key={n} size="xs" variant="default">
                    {n}
                  </Badge>
                ))}
                {metadata.materialNames.length > 6 && (
                  <Text size="xs" c="dimmed">
                    +{metadata.materialNames.length - 6}
                  </Text>
                )}
              </Group>
            </div>
          )}
          {filamentCost && resinCost ? (
            <div>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
                Print cost (rough)
              </Text>
              <Stack gap={2}>
                <Group justify="space-between" gap="xs">
                  <Text size="sm">Filament</Text>
                  <Text size="sm" c="dimmed">
                    ~${filamentCost.usd.toFixed(2)} · {formatGrams(filamentCost.grams)}
                  </Text>
                </Group>
                <Group justify="space-between" gap="xs">
                  <Text size="sm">Resin</Text>
                  <Text size="sm" c="dimmed">
                    ~${resinCost.usd.toFixed(2)} · {formatGrams(resinCost.grams)}
                  </Text>
                </Group>
              </Stack>
            </div>
          ) : (
            <Text size="xs" c="dimmed">
              Re-render this thumbnail to compute mesh volume and a print-cost
              estimate.
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}

function formatGrams(g: number): string {
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  if (g >= 10) return `${g.toFixed(0)} g`;
  return `${g.toFixed(1)} g`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </div>
  );
}
