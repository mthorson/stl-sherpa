import { ActionIcon, Group, Tooltip } from '@mantine/core';
import { IconStar, IconStarFilled } from '@tabler/icons-react';
import { MAX_RATING } from '@shared/ratings';

interface Props {
  /** Current rating, 0..5. */
  value: number;
  /** Called with the new rating; clicking the current star clears it (sets 0). */
  onChange: (rating: number) => void;
  /** When true, shows a hint that the current rating is mixed across selection. */
  mixed?: boolean;
  size?: number;
  disabled?: boolean;
}

/**
 * Five tappable stars + clear behavior — click a star at position N to set
 * rating=N, click the current star to clear to 0.
 *
 * `mixed` is for bulk mode: when the selection spans different ratings, show
 * hollow stars and a tooltip; clicking still sets the chosen rating across all.
 */
export function RatingWidget({ value, onChange, mixed = false, size = 14, disabled }: Props) {
  return (
    <Group gap={2} wrap="nowrap">
      {Array.from({ length: MAX_RATING }, (_, i) => {
        const star = i + 1;
        const filled = !mixed && value >= star;
        const next = value === star ? 0 : star;
        const label = mixed
          ? `Set rating to ${star} for all selected`
          : value === star
            ? 'Clear rating'
            : `Rate ${star}`;
        return (
          <Tooltip key={star} label={label} withinPortal>
            <ActionIcon
              variant="transparent"
              size="xs"
              disabled={disabled}
              onClick={() => onChange(next)}
              aria-label={label}
            >
              {filled ? (
                <IconStarFilled size={size} color="var(--mantine-color-yellow-5)" />
              ) : (
                <IconStar
                  size={size}
                  color={
                    mixed ? 'var(--mantine-color-gray-6)' : 'var(--mantine-color-dark-2)'
                  }
                />
              )}
            </ActionIcon>
          </Tooltip>
        );
      })}
    </Group>
  );
}
