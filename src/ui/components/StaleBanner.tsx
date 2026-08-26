/**
 * The recalculation call-to-action (DESIGN.md §3 "Banner"). `warning`
 * variant, pinned below the page header by the caller. Body text names
 * *what* went stale; the single action is the primary Recalculate button.
 *
 * Per DESIGN.md §3's "one banner at a time" rule, concurrent stale reasons
 * are merged into a single `reason` string upstream (in the store/App), not
 * stacked into multiple banners here.
 */
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

export interface StaleBannerProps {
  isStale: boolean;
  reason: string;
  onRecalculate: () => void;
}

export function StaleBanner({ isStale, reason, onRecalculate }: StaleBannerProps) {
  if (!isStale) return null;

  return (
    <Banner
      status="warning"
      title={reason}
      collapsible={false}
      endContent={<Button label="Recalculate" variant="primary" onClick={onRecalculate} />}
    />
  );
}
