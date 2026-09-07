import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { RefreshCw } from 'lucide-react'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'
import { getAccountsAutoSwitchSearchEntries } from './accounts-search'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function renderAccountsAutoSwitchSection(
  model: Pick<AccountsPaneSectionModel, 'settings' | 'updateSettings'>
): React.JSX.Element {
  const { settings, updateSettings } = model
  return (
    <section key="auto-switch-limits" id="accounts-auto-switch" className="space-y-3 scroll-mt-6">
      <SearchableSetting
        title={translate(
          'auto.components.settings.AccountsPane.b28bb41f63',
          'Auto-switch Limited Agents'
        )}
        description={translate(
          'auto.components.settings.AccountsPane.7d2634bfa1',
          'When a live Claude or Codex session hits an account limit, Orca can switch to another managed account and resume the same session.'
        )}
        keywords={getAccountsAutoSwitchSearchEntries().flatMap((entry) => [
          entry.title,
          entry.description ?? '',
          ...(entry.keywords ?? [])
        ])}
      >
        <SettingsRow
          label={translate(
            'auto.components.settings.AccountsPane.b28bb41f63',
            'Auto-switch Limited Agents'
          )}
          alignTop
          description={translate(
            'auto.components.settings.AccountsPane.5d6a7e20ef',
            'Exits the limited Claude or Codex agent, selects a managed account with available quota, resumes the provider session, then sends continue.'
          )}
          control={
            <Button
              variant={settings.autoSwitchRateLimitedAccounts ? 'default' : 'outline'}
              size="sm"
              onClick={() =>
                updateSettings({
                  autoSwitchRateLimitedAccounts: !settings.autoSwitchRateLimitedAccounts
                })
              }
              className="w-24 gap-1.5"
            >
              <RefreshCw className="size-3" />
              {settings.autoSwitchRateLimitedAccounts
                ? translate('auto.components.settings.AccountsPane.0f9197cfde', 'Enabled')
                : translate('auto.components.settings.AccountsPane.a103114594', 'Enable')}
            </Button>
          }
        />
      </SearchableSetting>
    </section>
  )
}
