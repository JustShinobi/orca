import { describe, expect, it } from 'vitest'
import {
  draftFromSettings,
  isApplicablePreviewDraft,
  settingsFromDraft
} from './PreviewProxySettingsSection'

describe('PreviewProxySettingsSection drafts', () => {
  it('renders an unset proxy as an empty draft on auto auth', () => {
    expect(draftFromSettings(undefined)).toEqual({
      domain: '',
      port: '',
      bindHost: '',
      auth: 'auto',
      token: ''
    })
  })

  it('round-trips a persisted config through the draft', () => {
    const settings = {
      enabled: true,
      port: 6769,
      domain: 'https://preview.example.com',
      bindHost: '0.0.0.0',
      auth: 'token' as const,
      token: 'secret'
    }

    expect(settingsFromDraft(draftFromSettings(settings), true)).toEqual(settings)
  })

  it('omits optional fields so auto auth stays unpinned and the bind falls back to loopback', () => {
    expect(
      settingsFromDraft(
        {
          domain: ' https://preview.example.com ',
          port: '6769',
          bindHost: ' ',
          auth: 'auto',
          token: '  '
        },
        true
      )
    ).toEqual({ enabled: true, port: 6769, domain: 'https://preview.example.com' })
  })

  it('refuses to enable a draft the reconciler could never bind', () => {
    expect(isApplicablePreviewDraft(draftFromSettings(undefined))).toBe(false)
    expect(
      isApplicablePreviewDraft({
        domain: 'https://preview.example.com',
        port: '',
        bindHost: '',
        auth: 'auto',
        token: ''
      })
    ).toBe(false)
    expect(
      isApplicablePreviewDraft({
        domain: 'https://preview.example.com',
        port: '6769',
        bindHost: '',
        auth: 'auto',
        token: ''
      })
    ).toBe(true)
  })
})
