import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type {
  GlobalSettings,
  PreviewProxySettings,
  PreviewProxyStatus
} from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type PreviewProxySettingsSectionProps = {
  settings: Pick<GlobalSettings, 'previewProxy'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

type PreviewProxyDraft = {
  domain: string
  port: string
  bindHost: string
  auth: 'auto' | 'open' | 'token'
  token: string
}

// Why: the reconciler restarts the listener after the settings write lands;
// one delayed refetch shows the resulting state without polling.
const STATUS_REFRESH_DELAY_MS = 500

function draftFromSettings(preview: PreviewProxySettings | undefined): PreviewProxyDraft {
  return {
    domain: preview?.domain ?? '',
    port: preview?.port ? String(preview.port) : '',
    bindHost: preview?.bindHost ?? '',
    auth: preview?.auth ?? 'auto',
    token: preview?.token ?? ''
  }
}

function settingsFromDraft(draft: PreviewProxyDraft, enabled: boolean): PreviewProxySettings {
  return {
    enabled,
    port: Number.parseInt(draft.port, 10) || 0,
    domain: draft.domain.trim(),
    ...(draft.bindHost.trim() ? { bindHost: draft.bindHost.trim() } : {}),
    ...(draft.auth === 'auto' ? {} : { auth: draft.auth }),
    ...(draft.token.trim() ? { token: draft.token.trim() } : {})
  }
}

export function PreviewProxySettingsSection({
  settings,
  updateSettings
}: PreviewProxySettingsSectionProps): React.JSX.Element {
  const preview = settings.previewProxy
  const enabled = preview?.enabled === true
  const [draft, setDraft] = useState<PreviewProxyDraft>(() => draftFromSettings(preview))
  const [status, setStatus] = useState<PreviewProxyStatus | null>(null)

  const refreshStatus = useCallback(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api.previewProxy
        .status()
        .then((next) => {
          if (!cancelled) {
            setStatus(next)
          }
        })
        .catch(() => {})
    }, STATUS_REFRESH_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => refreshStatus(), [refreshStatus, preview])

  const dirty = JSON.stringify(draftFromSettings(preview)) !== JSON.stringify(draft)
  const canApply = draft.domain.trim() !== '' && Number.parseInt(draft.port, 10) > 0

  const apply = (nextEnabled: boolean): void => {
    updateSettings({ previewProxy: settingsFromDraft(draft, nextEnabled) })
  }

  const title = translate(
    'auto.components.settings.PreviewProxySettingsSection.a6d49f6741',
    'Workspace Preview Proxy'
  )
  const managedByFlags = status?.source === 'flags'

  return (
    <SearchableSetting
      title={title}
      description={translate(
        'auto.components.settings.PreviewProxySettingsSection.bfadb61ecf',
        'Expose workspace dev servers through one host-routed listener, so browsers and paired clients open them directly.'
      )}
      keywords={['preview', 'proxy', 'ports', 'dev server', 'domain', 'wildcard', 'serve', 'token']}
    >
      <SettingsSwitchRow
        label={title}
        description={translate(
          'auto.components.settings.PreviewProxySettingsSection.c5b96de11c',
          "Requests to <workspace>.<domain> are forwarded to that workspace's dev server. Point a wildcard DNS record and reverse-proxy route at the listener port."
        )}
        checked={enabled}
        onChange={() => apply(!enabled)}
        ariaLabel={translate(
          'auto.components.settings.PreviewProxySettingsSection.a4a7afac96',
          'Enable preview proxy'
        )}
      />
      <div className="grid grid-cols-2 gap-3 pb-2">
        <label className="col-span-2 block space-y-1">
          <Label className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PreviewProxySettingsSection.29f99ff349',
              'Public domain'
            )}
          </Label>
          <Input
            value={draft.domain}
            placeholder="https://preview.example.com"
            onChange={(event) => setDraft({ ...draft, domain: event.target.value })}
          />
        </label>
        <label className="block space-y-1">
          <Label className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PreviewProxySettingsSection.fa3d3820e3',
              'Listener port'
            )}
          </Label>
          <Input
            inputMode="numeric"
            value={draft.port}
            placeholder="6769"
            onChange={(event) =>
              setDraft({ ...draft, port: event.target.value.replace(/\D/g, '') })
            }
          />
        </label>
        <label className="block space-y-1">
          <Label className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PreviewProxySettingsSection.3743f05344',
              'Bind address'
            )}
          </Label>
          <Input
            value={draft.bindHost}
            placeholder="127.0.0.1"
            onChange={(event) => setDraft({ ...draft, bindHost: event.target.value })}
          />
        </label>
        <div className="block space-y-1">
          <Label className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PreviewProxySettingsSection.e54c382974',
              'Authentication'
            )}
          </Label>
          <div>
            <SettingsSegmentedControl
              size="sm"
              value={draft.auth}
              onChange={(auth) => setDraft({ ...draft, auth })}
              options={[
                {
                  value: 'auto',
                  label: translate(
                    'auto.components.settings.PreviewProxySettingsSection.bcee22a1ea',
                    'Auto'
                  )
                },
                {
                  value: 'open',
                  label: translate(
                    'auto.components.settings.PreviewProxySettingsSection.ab818db66b',
                    'Open'
                  )
                },
                {
                  value: 'token',
                  label: translate(
                    'auto.components.settings.PreviewProxySettingsSection.33b8314a61',
                    'Token'
                  )
                }
              ]}
            />
          </div>
        </div>
        <label className="block space-y-1">
          <Label className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PreviewProxySettingsSection.b2e49d6552',
              'Token value'
            )}
          </Label>
          <Input
            value={draft.token}
            onChange={(event) => setDraft({ ...draft, token: event.target.value })}
          />
        </label>
      </div>
      <div className="flex items-center justify-between gap-3 pb-2">
        <p className="min-w-0 flex-1 select-text text-xs text-muted-foreground">
          {managedByFlags
            ? translate(
                'auto.components.settings.PreviewProxySettingsSection.ccdbfdffff',
                'Configured by orca serve --preview-* flags; these settings apply after the server restarts without them.'
              )
            : status?.error
              ? translate(
                  'auto.components.settings.PreviewProxySettingsSection.448276c164',
                  'Preview proxy error: {{value0}}',
                  { value0: status.error }
                )
              : status?.running && status.origin
                ? translate(
                    'auto.components.settings.PreviewProxySettingsSection.1d15aae5bc',
                    'Running at {{value0}}',
                    { value0: status.origin }
                  )
                : translate(
                    'auto.components.settings.PreviewProxySettingsSection.d71f803a7d',
                    'Anyone who can reach the listener and pass its auth mode can reach your dev servers. Keep token auth on untrusted networks.'
                  )}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!dirty || !canApply}
          onClick={() => apply(enabled)}
        >
          {translate('auto.components.settings.PreviewProxySettingsSection.e759090f76', 'Apply')}
        </Button>
      </div>
      {status?.running && status.auth === 'token' && status.token && !preview?.token && (
        <p className="select-text pb-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PreviewProxySettingsSection.d77f62edce',
            'Generated session token: {{value0}}',
            { value0: status.token }
          )}
        </p>
      )}
    </SearchableSetting>
  )
}
