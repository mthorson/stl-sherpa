import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Center,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Tooltip
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCamera,
  IconRefresh,
  IconRotate2,
  IconRotateClockwise2
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { FileRecord } from '@shared/types';
import type { LightingStyle } from '@shared/lighting-types';
import { LIGHTING_PRESETS } from '../three/lighting-presets';
import {
  UP_AXIS_OPTIONS,
  YAW_STEP_DEG,
  getDefaultOrientation,
  getYaw,
  rotateYaw,
  type FileOrientation,
  type UpAxis
} from '@shared/orientation';
import { ModelViewer, type ModelViewerHandle } from '../three/ModelViewer';
import { CropOverlay } from './CropOverlay';
import { ipc } from '../ipc-client';
import { usePreferences } from '../util/use-preferences';
import { DEFAULT_RENDER_QUALITY } from '@shared/render-quality';

interface Props {
  libraryId: string | null;
  file: FileRecord | null;
  /** Total number of files currently selected. Drives the "N selected" overlay
   *  when > 1; otherwise no overlay. The viewer always shows `file` (the primary). */
  selectionCount: number;
  lightingStyle: LightingStyle;
  onLightingStyleChange: (style: LightingStyle) => void;
  onRerenderThumb: (fileId: number) => void;
}

/**
 * The interactive 3D preview pane: viewer canvas on top, controls (lighting,
 * orientation, capture-as-thumbnail) below it. Lives in the top half of the
 * center column. The right pane is reserved for non-render metadata.
 */
export function PreviewPane({
  libraryId,
  file,
  selectionCount,
  lightingStyle,
  onLightingStyleChange,
  onRerenderThumb
}: Props) {
  const viewerRef = useRef<ModelViewerHandle>(null);
  const { prefs } = usePreferences();
  const renderQuality = prefs?.renderQuality ?? DEFAULT_RENDER_QUALITY;
  // Side of the centered 1:1 crop region in CSS pixels. Recomputed on
  // resize so the overlay always matches what captureCurrentFrame() crops.
  const [cropSize, setCropSize] = useState(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const latestOrientationRef = useRef<{
    fileId: number | null;
    orientation: FileOrientation | null;
  }>({ fileId: null, orientation: null });
  if (latestOrientationRef.current.fileId !== (file?.id ?? null)) {
    latestOrientationRef.current = {
      fileId: file?.id ?? null,
      orientation: file?.orientation ?? null
    };
  }

  useEffect(() => {
    latestOrientationRef.current = {
      fileId: file?.id ?? null,
      orientation: file?.orientation ?? null
    };
  }, [file?.id, file?.orientation.upAxis, file?.orientation.yaw]);

  // Callback ref so the ResizeObserver attaches the moment the wrapper
  // div enters the DOM (after a file selection switches PreviewPane out of
  // its empty-state early return), and detaches when it leaves.
  const attachWrapperRef = useCallback((el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!el) {
      setCropSize(0);
      return;
    }
    const compute = () => {
      const rect = el.getBoundingClientRect();
      setCropSize(Math.floor(Math.min(rect.width, rect.height)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    resizeObserverRef.current = ro;
  }, []);

  if (!file || !libraryId) {
    return (
      <Center h="100%" p="md">
        <Text size="sm" c="dimmed">
          Select a file to preview.
        </Text>
      </Center>
    );
  }

  const yaw = getYaw(file.orientation);

  const setOrientation = (next: { upAxis?: UpAxis; yaw?: number }) => {
    const current = latestOrientationRef.current.orientation ?? file.orientation;
    const value = {
      upAxis: next.upAxis ?? current.upAxis,
      yaw: next.yaw ?? getYaw(current)
    };
    latestOrientationRef.current = { fileId: file.id, orientation: value };
    void ipc.setFileOrientation(file.libraryId, file.id, value);
  };

  const handleRotate = (deltaDeg: number) => {
    const current = latestOrientationRef.current.orientation ?? file.orientation;
    setOrientation({ yaw: rotateYaw(getYaw(current), deltaDeg) });
  };

  const handleCapture = async () => {
    try {
      const png = viewerRef.current?.hasModel()
        ? await viewerRef.current.captureCurrentFrame()
        : null;
      if (png && png.byteLength > 0) {
        // Snapshot the camera at capture time so reopening the file restarts
        // at the same angle the user chose for the thumbnail.
        const camera = viewerRef.current?.getCameraState() ?? null;
        await ipc.saveCustomThumbnail(file.libraryId, file.id, png, camera);
        return;
      }
    } catch (err) {
      notifications.show({
        color: 'orange',
        title: "Couldn't capture that view",
        message: `${(err as Error).message}. Rendering the default view instead.`
      });
    }
    onRerenderThumb(file.id);
  };

  return (
    <Stack gap={0} h="100%">
      {/* Viewer fills all available vertical space above the control strip. */}
      <div
        ref={attachWrapperRef}
        style={{ flex: 1, minHeight: 0, position: 'relative', background: '#101113' }}
      >
        <ModelViewer
          ref={viewerRef}
          libraryId={libraryId}
          file={file}
          lightingStyle={lightingStyle}
          renderQuality={renderQuality}
        />
        <CropOverlay size={cropSize} />
        {selectionCount > 1 && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              padding: '4px 8px',
              borderRadius: 4,
              background: 'rgba(0, 0, 0, 0.65)',
              color: 'var(--mantine-color-indigo-3)',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.3,
              pointerEvents: 'none',
              fontFamily: 'var(--mantine-font-family-monospace, monospace)'
            }}
          >
            {selectionCount} selected
          </div>
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          padding: '8px 12px',
          borderTop: '1px solid var(--mantine-color-dark-4)',
          background: 'var(--mantine-color-dark-7)'
        }}
      >
        <Stack gap={8}>
          {file.thumbError && !file.hasThumb && (
            <Alert
              variant="light"
              color="red"
              icon={<IconAlertTriangle size={14} />}
              title="Thumbnail render failed"
              p="xs"
            >
              <Text size="xs" mb={6} style={{ wordBreak: 'break-word' }}>
                {file.thumbError}
              </Text>
              <Button
                size="xs"
                variant="light"
                color="red"
                leftSection={<IconRefresh size={12} />}
                onClick={() => onRerenderThumb(file.id)}
              >
                Retry render
              </Button>
            </Alert>
          )}

          <Group justify="space-between" wrap="nowrap" gap="md">
            <Group gap="md" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
              <ControlBlock label="Lighting" hint={LIGHTING_PRESETS.find((p) => p.id === lightingStyle)?.label}>
                <Tooltip
                  label={LIGHTING_PRESETS.find((p) => p.id === lightingStyle)?.description}
                  withinPortal
                >
                  <SegmentedControl
                    size="xs"
                    value={lightingStyle}
                    onChange={(v) => onLightingStyleChange(v as LightingStyle)}
                    data={LIGHTING_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  />
                </Tooltip>
              </ControlBlock>

              <ControlBlock
                label="Up axis"
                hint={
                  file.orientationCustomized ? (
                    <Text
                      span
                      size="xs"
                      c="indigo"
                      style={{ cursor: 'pointer' }}
                      onClick={() => void ipc.setFileOrientation(file.libraryId, file.id, null)}
                    >
                      reset to default ({getDefaultOrientation(file.ext).upAxis})
                    </Text>
                  ) : (
                    file.orientation.upAxis
                  )
                }
              >
                <SegmentedControl
                  size="xs"
                  value={file.orientation.upAxis}
                  onChange={(v) => setOrientation({ upAxis: v as UpAxis })}
                  data={UP_AXIS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </ControlBlock>

              <ControlBlock label="Rotate" hint={`yaw ${yaw}°`}>
                <Group gap={4} wrap="nowrap">
                  <Tooltip label={`Rotate ${YAW_STEP_DEG}° counter-clockwise`}>
                    <ActionIcon
                      variant="default"
                      size="md"
                      onClick={() => handleRotate(-YAW_STEP_DEG)}
                      aria-label={`Rotate counter-clockwise by ${YAW_STEP_DEG} degrees`}
                    >
                      <IconRotate2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label={`Rotate ${YAW_STEP_DEG}° clockwise`}>
                    <ActionIcon
                      variant="default"
                      size="md"
                      onClick={() => handleRotate(YAW_STEP_DEG)}
                      aria-label={`Rotate clockwise by ${YAW_STEP_DEG} degrees`}
                    >
                      <IconRotateClockwise2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </ControlBlock>
            </Group>

            <Tooltip label="Capture current view as thumbnail">
              <ActionIcon
                variant="light"
                color="indigo"
                size="lg"
                onClick={() => void handleCapture()}
                aria-label="Capture current view as thumbnail"
              >
                <IconCamera size={18} />
              </ActionIcon>
            </Tooltip>

            <Badge variant="light" size="sm">
              .{file.ext}
            </Badge>
          </Group>
        </Stack>
      </div>
    </Stack>
  );
}

function ControlBlock({
  label,
  hint,
  children
}: {
  label: string;
  hint: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap={2} style={{ minWidth: 0 }}>
      <Group gap={6} wrap="nowrap">
        <Text size="xs" tt="uppercase" c="dimmed" fw={700}>
          {label}
        </Text>
        {hint != null && (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        )}
      </Group>
      {children}
    </Stack>
  );
}
