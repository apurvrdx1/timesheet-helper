/**
 * The recalculation call-to-action (DESIGN.md §3 "Banner"). `warning`
 * variant, pinned below the page header by the caller. Body text names
 * *what* went stale; the single action is the primary Recalculate button.
 *
 * Per DESIGN.md §3's "one banner at a time" rule, concurrent stale reasons
 * are merged into a single `reason` string upstream (in the store/App), not
 * stacked into multiple banners here.
 *
 * `onRecalculate` is optional because staleness and the action that clears it
 * are not the same thing. A schedule that was calculated and then had its
 * allocations removed IS stale — the stored schedule no longer matches the
 * model — but `recalculate` cannot succeed against an empty scheduling
 * window. Withholding the banner along with the button is how the sheet and
 * the screen came to disagree with nothing saying so.
 */
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

export interface StaleBannerProps {
  isStale: boolean;
  reason: string;
  /** Omitted when recalculation cannot succeed: the banner still states the
   *  fact, with no action that would only fail. */
  onRecalculate?: (() => void) | undefined;
}

export function StaleBanner({ isStale, reason, onRecalculate }: StaleBannerProps) {
  if (!isStale) return null;

  return (
    <Banner
      status="warning"
      title={reason}
      collapsible={false}
      endContent={
        onRecalculate === undefined
          ? undefined
          : <Button label="Recalculate" variant="primary" onClick={onRecalculate} />
      }
    />
  );
}
