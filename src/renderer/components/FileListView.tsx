import { memo, useMemo, useRef } from 'react';
import { Group, Text } from '@mantine/core';
import { IconCircleFilled, IconStarFilled } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileRecord } from '@shared/types';
import { COLOR_LABEL_HEX } from '@shared/ratings';
import { formatBytes, formatDateTime } from '../util/format';
import { parseFileMeta } from '../util/parse-meta';
import type { TileClickModifiers } from './ThumbGrid';

interface Props {
  /** Active library id, or null in "All Libraries" mode. Tile thumbs use
   *  `file.libraryId` so this prop is informational only. */
  libraryId: string | null;
  files: FileRecord[];
  selectedIds: ReadonlySet<number>;
  primaryId: number | null;
  thumbVersions: ReadonlyMap<number, number>;
  onTileClick: (fileId: number, modifiers: TileClickModifiers) => void;
  onTileContextMenu?: (fileId: number, x: number, y: number) => void;
}

const ROW_HEIGHT = 36;

/**
 * Dense list view of the same files as ThumbGrid. Reuses selection + click
 * handlers, so the user's mental model is consistent across both views.
 *
 * Columns: thumb (24×24), name, ext, size, modified, vertices, triangles, rating.
 * Sorting is driven from the parent's `sort` state; this component just
 * renders whatever order it's given.
 */
export function FileListView({
  libraryId: _libraryId,
  files,
  selectedIds,
  primaryId,
  thumbVersions,
  onTileClick,
  onTileContextMenu
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  });

  if (files.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--mantine-color-dimmed)'
        }}
      >
        <Text size="sm">No 3D files here yet.</Text>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        background: 'var(--mantine-color-dark-7)'
      }}
    >
      <Header />
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative'
        }}
      >
        {virtualizer.getVirtualItems().map((vRow) => {
          const file = files[vRow.index];
          return (
            <Row
              key={file.id}
              file={file}
              thumbVersion={thumbVersions.get(file.id) ?? 0}
              selected={selectedIds.has(file.id)}
              isPrimary={primaryId === file.id}
              offsetY={vRow.start}
              onTileClick={onTileClick}
              onTileContextMenu={onTileContextMenu}
            />
          );
        })}
      </div>
    </div>
  );
}

const HEADER_HEIGHT = 28;

function Header() {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        height: HEADER_HEIGHT,
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        gap: 8,
        padding: '0 12px',
        alignItems: 'center',
        background: 'var(--mantine-color-dark-7)',
        borderBottom: '1px solid var(--mantine-color-dark-4)',
        fontSize: 10,
        textTransform: 'uppercase',
        color: 'var(--mantine-color-dimmed)',
        fontWeight: 700,
        letterSpacing: 0.4
      }}
    >
      <div />
      <div>Name</div>
      <div>Ext</div>
      <div style={{ textAlign: 'right' }}>Size</div>
      <div>Modified</div>
      <div style={{ textAlign: 'right' }}>Verts</div>
      <div style={{ textAlign: 'right' }}>Tris</div>
      <div>Rating</div>
      <div>Label</div>
    </div>
  );
}

const COLUMNS = '24px minmax(120px, 1fr) 36px 70px 140px 70px 70px 60px 40px';

// Memoized for the same reason as ThumbGrid's Tile: thumb-rendered storms
// re-render the list constantly, and rows whose props are unchanged should
// skip both the re-render and the metadata re-parse.
const Row = memo(function Row({
  file,
  thumbVersion,
  selected,
  isPrimary,
  offsetY,
  onTileClick,
  onTileContextMenu
}: {
  file: FileRecord;
  thumbVersion: number;
  selected: boolean;
  isPrimary: boolean;
  offsetY: number;
  onTileClick: (fileId: number, modifiers: TileClickModifiers) => void;
  onTileContextMenu?: (fileId: number, x: number, y: number) => void;
}) {
  const meta = useMemo(() => parseFileMeta(file.metadataJson), [file.metadataJson]);
  const showThumb = file.hasThumb || thumbVersion > 0;
  const thumbUrl = showThumb ? `wh3d-thumb://${file.libraryId}/${file.id}?v=${thumbVersion}` : null;

  const onClick = (e: React.MouseEvent) => {
    onTileClick(file.id, { shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey });
  };
  const onContextMenu = (e: React.MouseEvent) => {
    if (!onTileContextMenu) return;
    e.preventDefault();
    // Finder-style, matching ThumbGrid: right-click outside the current
    // selection collapses it to the clicked row so the menu never acts on
    // files the user didn't aim at.
    if (!selected) {
      onTileClick(file.id, { shift: false, meta: false, ctrl: false });
    }
    onTileContextMenu(file.id, e.clientX, e.clientY);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={file.relPath}
      style={{
        all: 'unset',
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: ROW_HEIGHT,
        display: 'grid',
        gridTemplateColumns: COLUMNS,
        gap: 8,
        padding: '0 12px',
        alignItems: 'center',
        boxSizing: 'border-box',
        cursor: 'pointer',
        background: selected
          ? 'var(--mantine-color-dark-5)'
          : 'var(--mantine-color-dark-6)',
        borderLeft: isPrimary
          ? '2px solid var(--mantine-color-indigo-4)'
          : '2px solid transparent',
        borderBottom: '1px solid var(--mantine-color-dark-7)',
        transform: `translateY(${offsetY}px)`
      }}
    >
      <Thumb url={thumbUrl} ext={file.ext} />
      <Text size="xs" truncate>
        {file.filename}
      </Text>
      <Text size="xs" c="dimmed">
        {file.ext}
      </Text>
      <Text size="xs" c="dimmed" ta="right">
        {formatBytes(file.sizeBytes)}
      </Text>
      <Text size="xs" c="dimmed" truncate>
        {formatDateTime(file.mtimeMs)}
      </Text>
      <Text size="xs" c="dimmed" ta="right">
        {meta?.vertexCount?.toLocaleString() ?? '—'}
      </Text>
      <Text size="xs" c="dimmed" ta="right">
        {meta?.triangleCount?.toLocaleString() ?? '—'}
      </Text>
      <Group gap={1} wrap="nowrap">
        {file.rating > 0 ? (
          Array.from({ length: file.rating }, (_, i) => (
            <IconStarFilled key={i} size={9} color="var(--mantine-color-yellow-5)" />
          ))
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </Group>
      <div>
        {file.colorLabel ? (
          <IconCircleFilled size={12} color={COLOR_LABEL_HEX[file.colorLabel]} />
        ) : (
          <Text size="xs" c="dimmed">
            —
          </Text>
        )}
      </div>
    </button>
  );
});

function Thumb({ url, ext }: { url: string | null; ext: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        style={{
          width: 24,
          height: 24,
          borderRadius: 3,
          objectFit: 'cover',
          background: '#000'
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 24,
        height: 24,
        borderRadius: 3,
        background: 'var(--mantine-color-dark-5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 8,
        color: 'var(--mantine-color-dimmed)'
      }}
    >
      .{ext}
    </div>
  );
}
