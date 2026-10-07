import { forwardRef, useEffect, useRef } from 'react';
import { Group, Modal, Stack, Text } from '@mantine/core';
import type { FileRecord } from '@shared/types';
import type { LightingStyle } from '@shared/lighting-types';
import { ModelViewer, type ModelViewerHandle } from '../three/ModelViewer';
import { usePreferences } from '../util/use-preferences';
import { DEFAULT_RENDER_QUALITY, type RenderQuality } from '@shared/render-quality';

interface Props {
  opened: boolean;
  onClose: () => void;
  libraryId: string | null;
  left: FileRecord | null;
  right: FileRecord | null;
  lightingStyle: LightingStyle;
}

/**
 * Side-by-side comparison of exactly two models with synced cameras. Dragging
 * in either viewer rotates both. Each viewer is its own Three.js scene; we
 * sync via the handle's getCameraState / setCameraState / onCameraChange.
 */
export function CompareModal({ opened, onClose, libraryId, left, right, lightingStyle }: Props) {
  const leftRef = useRef<ModelViewerHandle>(null);
  const rightRef = useRef<ModelViewerHandle>(null);
  const { prefs } = usePreferences();
  const renderQuality = prefs?.renderQuality ?? DEFAULT_RENDER_QUALITY;

  // Hook up the bidirectional camera sync once both handles are alive.
  useEffect(() => {
    if (!opened) return;
    const L = leftRef.current;
    const R = rightRef.current;
    if (!L || !R) return;
    const offL = L.onCameraChange(() => {
      const state = L.getCameraState();
      if (state) R.setCameraState(state);
    });
    const offR = R.onCameraChange(() => {
      const state = R.getCameraState();
      if (state) L.setCameraState(state);
    });
    return () => {
      offL();
      offR();
    };
  }, [opened, left?.id, right?.id]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      withCloseButton
      title="Compare"
      padding={0}
      styles={{
        body: { height: 'calc(100vh - 60px)', padding: 0 },
        content: { background: '#101113' }
      }}
    >
      {!libraryId || !left || !right ? (
        <Stack align="center" justify="center" h="100%">
          <Text c="dimmed">Select exactly two files to compare.</Text>
        </Stack>
      ) : (
        <Group gap={0} h="100%" wrap="nowrap" style={{ background: '#000' }}>
          <ComparePane label={left.filename} libraryId={libraryId} file={left} ref={leftRef} lightingStyle={lightingStyle} renderQuality={renderQuality} />
          <div style={{ width: 1, background: 'var(--mantine-color-dark-4)' }} />
          <ComparePane label={right.filename} libraryId={libraryId} file={right} ref={rightRef} lightingStyle={lightingStyle} renderQuality={renderQuality} />
        </Group>
      )}
    </Modal>
  );
}

// forwardRef is required here: React strips a plain `ref` prop from function
// components, so without it the camera-sync handles never attach.
const ComparePane = forwardRef<
  ModelViewerHandle,
  {
    label: string;
    libraryId: string;
    file: FileRecord;
    lightingStyle: LightingStyle;
    renderQuality: RenderQuality;
  }
>(function ComparePane({ label, libraryId, file, lightingStyle, renderQuality }, ref) {
  return (
      <div
        style={{
          flex: 1,
          height: '100%',
          position: 'relative',
          minWidth: 0,
          background: '#101113'
        }}
      >
        <ModelViewer
          ref={ref}
          libraryId={libraryId}
          file={file}
          lightingStyle={lightingStyle}
          renderQuality={renderQuality}
        />
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            padding: '4px 8px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.65)',
            color: 'var(--mantine-color-indigo-3)',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'var(--mantine-font-family-monospace, monospace)',
            pointerEvents: 'none',
            maxWidth: 'calc(100% - 16px)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {label}
        </div>
      </div>
  );
});
