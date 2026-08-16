/**
 * Settings card for the dsh-taskboard plugin, rendered into the
 * `web-ui.plugin.item` slot of the settings panel. Self-contained: renders
 * on the shell's React copy (loader platform module) and the locale seat the
 * slot machinery binds from the register's `locale` namespace.
 */

import type { JSX } from 'react'

/** Open the taskboard panel from the settings card (apply listens for it). */
const REQUEST_OPEN_EVENT = 'dsh-taskboard-request-open'

export interface TaskboardSettingsCardProps {
  /** Namespace-bound translate provided by the slot renderer. */
  t: (key: string, params?: Record<string, unknown>) => string
}

export function TaskboardSettingsCard(props: TaskboardSettingsCardProps): JSX.Element {
  const { t } = props
  const open = (): void => {
    document.dispatchEvent(new CustomEvent(REQUEST_OPEN_EVENT))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontWeight: 600 }}>{t('card.title')}</span>
        <button
          type="button"
          onClick={open}
          style={{
            padding: '4px 12px',
            borderRadius: 6,
            border: '1px solid var(--dsw-specific-button-secondary-border, #d4d4d4)',
            background: 'var(--dsw-alias-bg-base, #ffffff)',
            color: 'var(--dsw-alias-label-primary, #1f1f1f)',
            cursor: 'pointer',
          }}
        >
          {t('card.open')}
        </button>
      </div>
      <div style={{ color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 12, lineHeight: 1.5 }}>
        {t('card.description')}
      </div>
      <div style={{ color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 12, lineHeight: 1.5 }}>
        {t('card.storage')}
      </div>
    </div>
  )
}